(function () {
  "use strict";

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  // v1은 요일 기반 분할(목요일/금요일)이었다. 4분할(상체A/하체A/상체B/하체B)로
  // 구조가 바뀌어서 옛 localStorage 데이터와 섞이지 않게 키를 올린다.
  var STORE_SESSION = "liftvoice.session.v2";
  var STORE_TWEAKS = "liftvoice.tweaks.v1";

  var tweaks = { vibe: "calm", focus: false, tone: "calm", unit: "kg" };

  var KG_TO_LB = 2.2046226218;

  function kgToLb(kg) { return Math.round(kg * KG_TO_LB * 10) / 10; }
  function lbToKgVal(lb) { return Math.round((lb / KG_TO_LB) * 10) / 10; }

  // 저장은 항상 kg. 화면에 보여줄 때만 현재 단위로 변환한다.
  function displayWeight(kg) { return tweaks.unit === "lb" ? kgToLb(kg) : kg; }
  function toStoredKg(displayVal) { return tweaks.unit === "lb" ? lbToKgVal(displayVal) : displayVal; }
  function weightUnitLabel() { return tweaks.unit === "lb" ? "lb" : "kg"; }

  // 모바일 number input엔 PC 스피너(위아래 화살표)가 없어서 값을 바꾸려면
  // 기존 숫자를 지우고 다시 입력해야 한다. 탭하면 바로 비워서 그냥 새
  // 숫자를 치면 되게 한다.
  function clearOnFocus(input) {
    input.addEventListener("focus", function () {
      input.value = "";
    });
  }

  function loadTweaks() {
    try {
      var raw = localStorage.getItem(STORE_TWEAKS);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          if (parsed.vibe === "power") tweaks.vibe = "power";
          if (parsed.tone === "power") tweaks.tone = "power";
          if (parsed.unit === "lb") tweaks.unit = "lb";
          tweaks.focus = !!parsed.focus;
        }
      }
    } catch (e) { /* corrupt or unavailable storage: use defaults */ }
  }

  function saveTweaks() {
    try { localStorage.setItem(STORE_TWEAKS, JSON.stringify(tweaks)); } catch (e) { /* quota or private mode */ }
  }

  var TONE_COPY = {
    condition: { calm: "기록했어요. 무리하지 마세요.", power: "기록 완료! 페이스 조절하면서 끝까지 밀어붙이자." },
    noSub: {
      calm: "이 종목은 등록된 대체 후보가 없어요. 직접 판단해서 진행하세요.",
      power: "대체 후보가 없어요 — 지금 있는 걸로 그냥 밀어붙이자!"
    }
  };

  function toneCopy(key) {
    var entry = TONE_COPY[key];
    return entry[tweaks.tone] || entry.calm;
  }

  function restCountdownText(remaining) {
    return tweaks.tone === "power" ? (remaining + "초만 더, 가자!") : ("휴식 " + remaining + "초");
  }

  function restDoneText() {
    return tweaks.tone === "power" ? "휴식 끝, 바로 간다!" : "휴식 종료 · 다음 세트 준비";
  }

  function applyTweaks() {
    document.documentElement.setAttribute("data-vibe", tweaks.vibe);
    document.body.classList.toggle("focus-active", tweaks.focus);
  }

  function syncTweaksUI() {
    Array.prototype.forEach.call(document.querySelectorAll("#tweaks-vibe .tweaks-opt"), function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-vibe-opt") === tweaks.vibe ? "true" : "false");
    });
    Array.prototype.forEach.call(document.querySelectorAll("#tweaks-tone .tweaks-opt"), function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-tone-opt") === tweaks.tone ? "true" : "false");
    });
    Array.prototype.forEach.call(document.querySelectorAll("#tweaks-unit .tweaks-opt"), function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-unit-opt") === tweaks.unit ? "true" : "false");
    });
    var focusBtn = document.getElementById("tweaks-focus");
    if (focusBtn) focusBtn.setAttribute("aria-pressed", tweaks.focus ? "true" : "false");
  }

  function buildInitialSession(routineName) {
    var name = ROUTINE_LIBRARY[routineName] ? routineName : DEFAULT_ROUTINE_NAME;
    return {
      routineName: name,
      currentPart: 0,
      currentExercise: 0,
      pendingSubstitute: null,
      parts: routinePartsFor(name).map(function (part) {
        return {
          name: part.name,
          exercises: part.exercises.map(function (ex) {
            return {
              id: ex.id,
              name: ex.name,
              isMain: ex.isMain,
              targetSets: ex.targetSets,
              targetReps: ex.targetReps,
              restSec: ex.restSec,
              sets: [],
              comments: [],
              setNotes: {}, // 아직 완료 안 한 세트에 미리 달아둔 메모: { "세트인덱스": "텍스트" }
              substitutedFrom: null
            };
          })
        };
      })
    };
  }

  // 사용자가 다른 요일 루틴으로 전환할 때 쓴다. 지금 루틴의 진행 상태는
  // state.routineSessions에 캐시해뒀다가, 그 루틴으로 돌아오면 그대로
  // 복원한다 — 요일마다 독립적으로 기록이 쌓이고 서로 지우지 않는다.
  function switchRoutine(routineName) {
    var name = ROUTINE_LIBRARY[routineName] ? routineName : DEFAULT_ROUTINE_NAME;
    state.routineSessions[state.session.routineName] = state.session;
    state.session = state.routineSessions[name] || buildInitialSession(name);
    delete state.routineSessions[name];
    state.session.pendingSubstitute = null;
    state.sessionCondMessage = null;
    state.sessionSubMessage = null;
    state.routineExpandedId = null;
    state.routineAddingPart = null;
    state.editingSetKey = null;
    stopRestCountdown();
    saveSession();
    renderSession();
  }

  // 구버전에 저장된 세션엔 setNotes가 없을 수 있고, targetReps가
  // [최소, 최대] 배열이던 시절 데이터도 있을 수 있다. 저장 형태가
  // 깨져 있으면(파트가 없거나 인덱스가 범위 밖) null을 돌려준다.
  function normalizeStoredSession(parsed) {
    if (!parsed || !Array.isArray(parsed.parts) || !parsed.parts.length) return null;
    // 저장된 인덱스가 배열 범위를 벗어나면 currentSessionExercise()가
    // 부팅 중 renderSession()에서 throw하고, 그러면 buildRecognizer()
    // 이전이라 free/script 모드까지 전부 죽는다. 방어적으로 clamp한다.
    var pi = Number(parsed.currentPart);
    if (!isFinite(pi)) pi = 0;
    pi = Math.min(Math.max(Math.floor(pi), 0), parsed.parts.length - 1);
    var part = parsed.parts[pi];
    if (!part || !Array.isArray(part.exercises) || !part.exercises.length) return null;
    var ei = Number(parsed.currentExercise);
    if (!isFinite(ei)) ei = 0;
    ei = Math.min(Math.max(Math.floor(ei), 0), part.exercises.length - 1);
    parsed.currentPart = pi;
    parsed.currentExercise = ei;
    if (!parsed.pendingSubstitute) parsed.pendingSubstitute = null;
    parsed.parts.forEach(function (p) {
      p.exercises.forEach(function (ex) {
        if (!ex.setNotes || typeof ex.setNotes !== "object") ex.setNotes = {};
        if (Array.isArray(ex.targetReps)) {
          ex.targetReps = ex.targetReps[ex.targetReps.length - 1] || ex.targetReps[0] || 1;
        }
      });
    });
    return parsed;
  }

  // 요일별로 따로 저장된 세션들을 전부 불러온다. state.routineSessions에
  // (활성 루틴을 포함해) 전부 채워 넣고, 활성 루틴의 세션을 반환한다.
  function loadSession() {
    try {
      var raw = localStorage.getItem(STORE_SESSION);
      if (raw) {
        var stored = JSON.parse(raw);
        var sessionsMap = {};
        var activeName = DEFAULT_ROUTINE_NAME;

        if (stored && stored.sessions && typeof stored.sessions === "object") {
          // 요일별로 나뉘어 저장된 포맷.
          if (ROUTINE_LIBRARY[stored.activeRoutineName]) activeName = stored.activeRoutineName;
          Object.keys(stored.sessions).forEach(function (name) {
            var norm = normalizeStoredSession(stored.sessions[name]);
            if (norm) {
              norm.routineName = name;
              sessionsMap[name] = norm;
            }
          });
        } else if (stored && Array.isArray(stored.parts)) {
          // 루틴을 하나만 저장하던 구버전 포맷 — 그 세션의 루틴 이름(없으면
          // 기본 루틴)으로 새 포맷에 마이그레이션한다.
          var norm2 = normalizeStoredSession(stored);
          if (norm2) {
            activeName = ROUTINE_LIBRARY[norm2.routineName] ? norm2.routineName : DEFAULT_ROUTINE_NAME;
            norm2.routineName = activeName;
            sessionsMap[activeName] = norm2;
          }
        }

        if (!sessionsMap[activeName]) sessionsMap[activeName] = buildInitialSession(activeName);
        state.routineSessions = sessionsMap;
        return sessionsMap[activeName];
      }
    } catch (e) { /* corrupt or unavailable storage: start fresh */ }
    state.routineSessions = {};
    return buildInitialSession(DEFAULT_ROUTINE_NAME);
  }

  function saveSession() {
    try {
      var sessions = {};
      Object.keys(state.routineSessions).forEach(function (name) {
        sessions[name] = state.routineSessions[name];
      });
      sessions[state.session.routineName] = state.session;
      localStorage.setItem(STORE_SESSION, JSON.stringify({
        activeRoutineName: state.session.routineName,
        sessions: sessions
      }));
    } catch (e) { /* quota or private mode: keep working in memory */ }
  }

  var DEFAULT_ROUTINE_NAME = "상체1";

  // 요일별로 따로 저장된 루틴들. 세션을 새로 시작할 때 이 중 하나를
  // 템플릿으로 골라서 state.session.parts를 채운다(실제 진행 상태는
  // 세션 시작 이후 여기와 별개로 저장된다).
  // 2026-08-03부로 요일 기반 분할(목요일/금요일)에서 4분할(상체1/하체1/상체2/하체2)로
  // 전환했다. 이름에 A/B 대신 숫자를 쓴 이유: classifyCommand가 인식 문장을
  // 전부 toLowerCase()하기 때문에 "하체 A"로 지으면 음성/텍스트로 "루틴 전환"을
  // 말해도 매칭 키가 "하체 a"가 되어 ROUTINE_NAME_LIST의 "하체 A"와 영영 안 맞는다.
  // 하체1은 그날 실제로 준 루틴을 그대로 옮긴 것 — 이 스키마엔 목표 무게
  // 필드가 없어서(무게는 항상 음성/입력으로 그때그때 기록), 스쿼트의 웜업·램프·백오프는
  // "데드리프트 웜업1/웜업2/웜업3/Top Single"과 같은 기존 관례대로 세트를 낱개
  // 종목으로 쪼개고 참고 무게를 이름에 적어뒀다.
  var ROUTINE_LIBRARY = {
    "상체1": [
      {
        name: "상체1",
        exercises: [
          { id: "todo_upper_a", name: "(종목 미입력 — 상체1)", isMain: false, targetSets: 1, targetReps: 1, restSec: 60 }
        ]
      }
    ],
    "하체1": [
      {
        name: "하체1",
        exercises: [
          { id: "squat_warmup1", name: "스쿼트 웜업1 (빈 바)", isMain: false, targetSets: 1, targetReps: 10, restSec: 60 },
          { id: "squat_warmup2", name: "스쿼트 웜업2 (60kg)", isMain: false, targetSets: 1, targetReps: 5, restSec: 60 },
          { id: "squat_warmup3", name: "스쿼트 웜업3 (80kg)", isMain: false, targetSets: 1, targetReps: 3, restSec: 90 },
          { id: "squat_warmup4", name: "스쿼트 웜업4 (100kg)", isMain: false, targetSets: 1, targetReps: 2, restSec: 120 },
          { id: "squat_set1", name: "스쿼트 세트1 (110kg · 적응)", isMain: false, targetSets: 1, targetReps: 5, restSec: 150 },
          { id: "squat_set2", name: "스쿼트 세트2 (120kg · 메인, RPE 8.5)", isMain: true, targetSets: 1, targetReps: 5, restSec: 180 },
          { id: "squat_set3", name: "스쿼트 세트3 (120kg · 메인)", isMain: true, targetSets: 1, targetReps: 5, restSec: 180 },
          { id: "squat_set4", name: "스쿼트 세트4 (115kg · 볼륨)", isMain: false, targetSets: 1, targetReps: 6, restSec: 150 },
          { id: "squat_set5", name: "스쿼트 세트5 (100kg · 백오프, 선택)", isMain: false, targetSets: 1, targetReps: 8, restSec: 120 },
          { id: "stiff_leg_deadlift", name: "스티프 레그드 데드리프트 (60~80kg)", isMain: false, targetSets: 3, targetReps: 12, restSec: 90 },
          { id: "leg_press", name: "레그 프레스 (120→160→180kg)", isMain: false, targetSets: 4, targetReps: 12, restSec: 90 },
          { id: "leg_curl_lying", name: "라잉 레그 컬", isMain: false, targetSets: 3, targetReps: 15, restSec: 60 },
          { id: "leg_extension", name: "레그 익스텐션", isMain: false, targetSets: 3, targetReps: 15, restSec: 60 },
          { id: "standing_calf_raise", name: "스탠딩 카프 레이즈 (120~200kg)", isMain: false, targetSets: 3, targetReps: 12, restSec: 60 }
        ]
      }
    ],
    "상체2": [
      {
        name: "상체2",
        exercises: [
          { id: "todo_upper_b", name: "(종목 미입력 — 상체2)", isMain: false, targetSets: 1, targetReps: 1, restSec: 60 }
        ]
      }
    ],
    "하체2": [
      {
        name: "하체2",
        exercises: [
          { id: "todo_lower_b", name: "(종목 미입력 — 하체2)", isMain: false, targetSets: 1, targetReps: 1, restSec: 60 }
        ]
      }
    ]
  };

  var ROUTINE_NAME_LIST = Object.keys(ROUTINE_LIBRARY);

  function routinePartsFor(routineName) {
    return ROUTINE_LIBRARY[routineName] || ROUTINE_LIBRARY[DEFAULT_ROUTINE_NAME];
  }

  function currentPartNameList() {
    return routinePartsFor(state.session && state.session.routineName).map(function (p) { return p.name; });
  }

  var NUM_WORDS = {
    "영": "0", "공": "0", "하나": "1", "한": "1", "일": "1", "둘": "2", "두": "2", "이": "2",
    "셋": "3", "세": "3", "삼": "3", "넷": "4", "네": "4", "사": "4", "다섯": "5", "오": "5",
    "여섯": "6", "육": "6", "일곱": "7", "칠": "7", "여덟": "8", "팔": "8", "아홉": "9", "구": "9",
    "열": "10", "십": "10", "스물": "20", "이십": "20", "서른": "30", "삼십": "30",
    "마흔": "40", "사십": "40", "쉰": "50", "오십": "50", "예순": "60", "육십": "60",
    "일흔": "70", "칠십": "70", "여든": "80", "팔십": "80", "아흔": "90", "구십": "90",
    "백": "100"
  };

  var SINO_DIGIT = { "영": 0, "공": 0, "일": 1, "이": 2, "삼": 3, "사": 4, "오": 5, "육": 6, "칠": 7, "팔": 8, "구": 9 };
  var SINO_UNIT = { "십": 10, "백": 100, "천": 1000 };

  // NUM_WORDS는 한 단어짜리 수사만 커버한다("백"=100). "백오십"(150),
  // "이백삼십오"(235)처럼 100 이상인 한자어 복합 수사는 별도로 조립해야
  // 한다 — 데드리프트 무게(140~160kg대)처럼 실제로 자주 나오는 값이라
  // 이게 안 되면 무게가 큰 세트는 전부 인식 실패로 빠진다.
  function parseSinoKoreanNumber(word) {
    if (!word || !/^[영공일이삼사오육칠팔구십백천]+$/.test(word)) return null;
    var total = 0;
    var section = 0;
    var chars = word.split("");
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      if (Object.prototype.hasOwnProperty.call(SINO_UNIT, ch)) {
        section = (section === 0 ? 1 : section) * SINO_UNIT[ch];
        total += section;
        section = 0;
      } else if (Object.prototype.hasOwnProperty.call(SINO_DIGIT, ch)) {
        section = SINO_DIGIT[ch];
      }
    }
    total += section;
    return total > 0 ? total : null;
  }

  // 단어 하나를 숫자 문자열로 바꾼다. NUM_WORDS에 바로 있으면 그걸 쓰고,
  // 없으면 한자어 복합 수사 파싱을 시도한다. 둘 다 실패하면 null.
  function koreanWordToDigitString(word) {
    if (Object.prototype.hasOwnProperty.call(NUM_WORDS, word)) return NUM_WORDS[word];
    var n = parseSinoKoreanNumber(word);
    return n == null ? null : String(n);
  }

  // 음성인식(특히 크롬)이 최종 결과에 붙이는 마침표/쉼표 등을 제거한다.
  // 소수점(예: "2.5")은 숫자 사이 마침표만 보존해서 지운다.
  function stripPunctuation(s) {
    return s.replace(/[.,!?~"'`·…\-]/g, function (match, offset, str) {
      if (match === ".") {
        var prevIsDigit = offset > 0 && /\d/.test(str[offset - 1]);
        var nextIsDigit = offset < str.length - 1 && /\d/.test(str[offset + 1]);
        if (prevIsDigit && nextIsDigit) {
          return ".";
        }
      }
      return " ";
    });
  }

  function wordsToDigitString(text) {
    var s = String(text == null ? "" : text).toLowerCase();
    s = stripPunctuation(s);
    s = s.replace(/kg|km|킬로그램|킬로|키로/g, "키로");
    s = s.replace(/lbs|lb|파운드/g, "파운드");
    s = s.replace(/초간|초동안/g, "초");
    var words = s.split(/\s+/).filter(function (w) { return w.length > 0; });
    var out = words.map(function (w) {
      var m = w.match(/^(.+?)(개|회|번|초|키로|파운드)$/);
      if (m) {
        var num = koreanWordToDigitString(m[1]);
        if (num != null) return num + m[2];
      }
      var whole = koreanWordToDigitString(w);
      return whole != null ? whole : w;
    });
    return out.join(" ");
  }

  function classifyCommand(rawText) {
    var text = wordsToDigitString(rawText).trim();

    var adjustWeight = text.match(/방금\s*(?:세트|거)?\s*(\d+(?:\.\d+)?)\s*(키로|파운드)\s*(더|빼)/);
    if (adjustWeight) {
      var adjustRaw = parseFloat(adjustWeight[1]);
      return {
        type: "SET_ADJUST_WEIGHT",
        amountKg: adjustWeight[2] === "파운드" ? lbToKgVal(adjustRaw) : adjustRaw,
        direction: adjustWeight[3] === "더" ? "add" : "subtract"
      };
    }

    var adjustReps = text.match(/방금\s*거\s*(\d+)\s*개로\s*수정/);
    if (adjustReps) {
      return { type: "SET_ADJUST_REPS", reps: parseInt(adjustReps[1], 10) };
    }

    var comment = text.match(/^(?:코멘트|메모)\s*[:,]?\s*(.+)$/);
    if (comment) {
      return { type: "COMMENT", text: comment[1].trim() };
    }

    if (/힘들어|컨디션\s*별로/.test(text)) {
      return { type: "CONDITION", text: rawText.trim() };
    }

    if (/자리\s*없어|기구\s*없어|없어서|없네/.test(text)) {
      return { type: "SUBSTITUTE_REQUEST" };
    }

    if (/전체\s*루틴|루틴\s*(?:전체)?\s*보여줘|루틴\s*확인|오늘\s*루틴/.test(text)) {
      return { type: "ROUTINE_OVERVIEW" };
    }

    var routineSwitchMatch = text.match(/^(.+?)\s*루틴(?:으로)?\s*시작(?:할래|해줘|하자)?$/);
    if (routineSwitchMatch) {
      return { type: "ROUTINE_SWITCH", routineName: routineSwitchMatch[1].trim() };
    }

    var partRemainRe = new RegExp("(" + currentPartNameList().join("|") + ")\\s*(?:운동)?\\s*(?:은|는)?\\s*(?:뭐가?\\s*남았|얼마나\\s*남았|남은\\s*거)");
    var partRemainMatch = text.match(partRemainRe);
    if (partRemainMatch) {
      return { type: "PART_REMAINING", partQuery: partRemainMatch[1] };
    }

    var exerciseQueryMatch = text.match(/^(.+?)\s*(?:는|은|이|가)?\s*몇\s*세트(?:야|예요|입니까|인가요|이야)?\??$/);
    if (exerciseQueryMatch) {
      return { type: "EXERCISE_QUERY", nameQuery: exerciseQueryMatch[1].trim() };
    }

    var targetSetsExact = text.match(/^(\d+)\s*세트만$/);
    if (targetSetsExact) {
      return { type: "TARGET_ADJUST", mode: "set", targetSets: parseInt(targetSetsExact[1], 10) };
    }
    if (/세트\s*(?:하나|1)\s*빼자/.test(text)) {
      return { type: "TARGET_ADJUST", mode: "delta", delta: -1 };
    }

    if (/^다음\s*종목$/.test(text)) {
      return { type: "NEXT_EXERCISE" };
    }

    if (/오늘\s*끝|운동\s*끝/.test(text)) {
      return { type: "SESSION_END" };
    }

    // UI가 "목표 4세트 × 6~8회"라고 보여주므로 "회"/"번"도 "개"와 동일하게 받는다.
    // 무게는 "키로"(kg) 또는 "파운드"(lb)로 말할 수 있고, lb는 항상 kg로 환산해 저장한다.
    var setLog = text.match(/^(?:(\d+(?:\.\d+)?)\s*(키로|파운드)\s*)?(\d+)\s*(?:개|회|번)$/);
    if (setLog) {
      var setLogRaw = setLog[1] ? parseFloat(setLog[1]) : null;
      return {
        type: "SET_LOG",
        weightKg: setLogRaw == null ? null : (setLog[2] === "파운드" ? lbToKgVal(setLogRaw) : setLogRaw),
        reps: parseInt(setLog[3], 10)
      };
    }

    return { type: "UNRECOGNIZED" };
  }

  function selfTestCommands() {
    var cases = [
      ["방금 세트 2.5키로 더", { type: "SET_ADJUST_WEIGHT", amountKg: 2.5, direction: "add" }],
      ["방금 세트 5키로 빼", { type: "SET_ADJUST_WEIGHT", amountKg: 5, direction: "subtract" }],
      ["방금 거 6개로 수정", { type: "SET_ADJUST_REPS", reps: 6 }],
      ["코멘트 어깨 뻐근함", { type: "COMMENT", text: "어깨 뻐근함" }],
      ["지금 힘들어", { type: "CONDITION", text: "지금 힘들어" }],
      ["여기 자리 없어", { type: "SUBSTITUTE_REQUEST" }],
      ["3세트만", { type: "TARGET_ADJUST", mode: "set", targetSets: 3 }],
      ["세트 하나 빼자", { type: "TARGET_ADJUST", mode: "delta", delta: -1 }],
      ["다음 종목", { type: "NEXT_EXERCISE" }],
      ["오늘 끝", { type: "SESSION_END" }],
      ["45키로 8개", { type: "SET_LOG", weightKg: 45, reps: 8 }],
      ["8개", { type: "SET_LOG", weightKg: null, reps: 8 }],
      ["여덟개", { type: "SET_LOG", weightKg: null, reps: 8 }],
      ["45키로 8회", { type: "SET_LOG", weightKg: 45, reps: 8 }],
      ["8번", { type: "SET_LOG", weightKg: null, reps: 8 }],
      ["여덟번", { type: "SET_LOG", weightKg: null, reps: 8 }],
      ["45키로 여덟 회", { type: "SET_LOG", weightKg: 45, reps: 8 }],
      ["20키로 8개.", { type: "SET_LOG", weightKg: 20, reps: 8 }],
      ["다음 종목.", { type: "NEXT_EXERCISE" }],
      ["45파운드 8개", { type: "SET_LOG", weightKg: 20.4, reps: 8 }],
      ["방금 세트 5파운드 더", { type: "SET_ADJUST_WEIGHT", amountKg: 2.3, direction: "add" }],
      ["백오십키로 한개", { type: "SET_LOG", weightKg: 150, reps: 1 }],
      ["백육십키로 두개", { type: "SET_LOG", weightKg: 160, reps: 2 }],
      ["백삼십오키로 3개", { type: "SET_LOG", weightKg: 135, reps: 3 }],
      ["전체 루틴 보여줘", { type: "ROUTINE_OVERVIEW" }],
      ["오버헤드프레스 몇 세트야", { type: "EXERCISE_QUERY", nameQuery: "오버헤드프레스" }],
      ["하체2 루틴 시작", { type: "ROUTINE_SWITCH", routineName: "하체2" }],
      ["하체1 루틴으로 시작해줘", { type: "ROUTINE_SWITCH", routineName: "하체1" }],
      ["아무말 대잔치", { type: "UNRECOGNIZED" }]
    ];
    // 어느 루틴이 활성 상태든 통하도록, 지금 활성 루틴의 파트 이름으로
    // PART_REMAINING 케이스를 동적으로 만든다(하드코딩하면 활성 루틴에
    // 따라 이 테스트만 스푸리어스하게 실패한다).
    var partNames = currentPartNameList();
    if (partNames.length) {
      cases.push([partNames[0] + " 운동 뭐 남았어", { type: "PART_REMAINING", partQuery: partNames[0] }]);
    }
    var pass = 0, fail = 0, failures = [];
    cases.forEach(function (c) {
      var got = classifyCommand(c[0]);
      var ok = JSON.stringify(got) === JSON.stringify(c[1]);
      if (ok) {
        pass++;
      } else {
        fail++;
        failures.push('"' + c[0] + '" -> ' + JSON.stringify(got) + ", 기대 " + JSON.stringify(c[1]));
      }
    });
    return { pass: pass, fail: fail, failures: failures };
  }

  var el = {
    banner: document.getElementById("banner"),
    live: document.getElementById("live"),
    statusText: document.getElementById("status-text"),
    transcript: document.getElementById("transcript"),
    rec: document.getElementById("rec"),
    recLabel: document.getElementById("rec-label"),
    exportBox: document.getElementById("export"),
    btnExport: document.getElementById("btn-export"),
    btnClear: document.getElementById("btn-clear"),
    typeInput: document.getElementById("type-input"),
    btnTypeSend: document.getElementById("btn-type-send"),
    sessionPanel: document.getElementById("session-panel"),
    sessionPartName: document.getElementById("session-part-name"),
    sessionProgress: document.getElementById("session-progress"),
    sessionExerciseName: document.getElementById("session-exercise-name"),
    sessionTarget: document.getElementById("session-target"),
    sessionNextSet: document.getElementById("session-next-set"),
    sessionTargetSetsInput: document.getElementById("session-target-sets-input"),
    sessionRestInput: document.getElementById("session-rest-input"),
    routineSelect: document.getElementById("routine-select"),
    btnSessionEnd: document.getElementById("btn-session-end"),
    sessionRestTimer: document.getElementById("session-rest-timer"),
    sessionLog: document.getElementById("session-log"),
    sessionSubBanner: document.getElementById("session-sub-banner"),
    sessionSubActions: document.getElementById("session-sub-actions"),
    btnSubApply: document.getElementById("btn-sub-apply"),
    btnSubDismiss: document.getElementById("btn-sub-dismiss"),
    sessionCondBanner: document.getElementById("session-cond-banner"),
    btnRoutineOverview: document.getElementById("btn-routine-overview"),
    routineOverlay: document.getElementById("routine-overlay"),
    routineBackdrop: document.getElementById("routine-backdrop"),
    routineBody: document.getElementById("routine-body"),
    btnRoutineClose: document.getElementById("btn-routine-close"),
    btnHelpOpen: document.getElementById("btn-help-open"),
    helpOverlay: document.getElementById("help-overlay"),
    helpBackdrop: document.getElementById("help-backdrop"),
    btnHelpClose: document.getElementById("btn-help-close")
  };

  var state = {
    listening: false,     // user intent: should we be capturing
    running: false,       // engine actually running
    session: null,
    routineSessions: {}, // 활성 상태가 아닌 요일 루틴들의 저장된 세션 캐시 (이름 -> 세션)
    // 표시 전용(비영속) 배너 상태. renderSession()이 매 렌더마다 배너를
    // 강제로 숨기기 때문에, 배너를 렌더 사이에 살려두려면 state가 필요하다.
    sessionCondMessage: null,  // 컨디션 배너: 다음 종목/다음 컨디션 보고까지 유지
    sessionSubMessage: null,   // "대체 후보 없음" 일회성 안내: 다음 렌더에서 소진
    routineOverlayOpen: false, // 전체 루틴 패널 표시 여부(비영속 — 세션 진행 상태와 무관)
    routineExpandedId: null,   // 패널에서 펼쳐진 종목 id
    routineAddingPart: null,   // 종목 추가 폼이 열려 있는 파트 인덱스(비영속)
    editingSetKey: null,       // 메모 입력 중인 세트 인덱스(문자열, 비영속)
    restEndsAt: null,          // 휴식 타이머 종료 시각(ms epoch, 비영속)
    restIntervalId: null       // 휴식 타이머 setInterval id
  };

  var rec = null;
  var startWatchdog = null;

  /* ---------- rendering ---------- */

  function setStatus(text, hot) {
    el.statusText.textContent = text;
    el.live.classList.toggle("hot", !!hot);
  }

  function showBanner(html, bad) {
    el.banner.innerHTML = html;
    el.banner.classList.add("show");
    el.banner.classList.toggle("bad", !!bad);
  }

  function renderTranscript(finalText, interimText) {
    if (!finalText && !interimText) {
      el.transcript.innerHTML = '<span class="placeholder">아래 버튼을 누르고 말해보세요. 예: "110키로 5개"</span>';
      return;
    }
    el.transcript.textContent = "";
    if (finalText) {
      el.transcript.appendChild(document.createTextNode(finalText + " "));
    }
    if (interimText) {
      var s = document.createElement("span");
      s.className = "interim";
      s.textContent = interimText;
      el.transcript.appendChild(s);
    }
  }

  function currentSessionExercise() {
    var part = state.session.parts[state.session.currentPart];
    return part.exercises[state.session.currentExercise];
  }

  function renderRoutineSelect() {
    if (!el.routineSelect) return;
    if (el.routineSelect.options.length !== ROUTINE_NAME_LIST.length) {
      el.routineSelect.innerHTML = "";
      ROUTINE_NAME_LIST.forEach(function (name) {
        var opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        el.routineSelect.appendChild(opt);
      });
    }
    el.routineSelect.value = state.session.routineName;
  }

  function renderSession() {
    renderRoutineSelect();

    var part = state.session.parts[state.session.currentPart];
    var ex = currentSessionExercise();

    el.sessionPartName.textContent = part.name;
    el.sessionProgress.textContent =
      (state.session.currentExercise + 1) + " / " + part.exercises.length + " 종목";
    el.sessionExerciseName.textContent = ex.name;

    el.sessionTarget.textContent =
      "목표 " + ex.targetSets + "세트 × " + ex.targetReps + "회 · " + ex.sets.length + "/" + ex.targetSets;

    if (ex.sets.length >= ex.targetSets) {
      el.sessionNextSet.textContent = "완료 · 목표 세트 다 채웠어요 — \"다음 종목\"이라고 말해보세요";
    } else {
      el.sessionNextSet.textContent =
        "▶ 진행중 · " + part.name + " · " + ex.name + " · " + (ex.sets.length + 1) + "번째 세트 (" + ex.targetReps + "회 목표)";
    }

    // 사용자가 지금 이 입력칸에 타이핑 중이면 렌더가 값을 덮어쓰지 않게 한다.
    if (el.sessionRestInput && document.activeElement !== el.sessionRestInput) {
      el.sessionRestInput.value = ex.restSec || 90;
    }
    if (el.sessionTargetSetsInput && document.activeElement !== el.sessionTargetSetsInput) {
      el.sessionTargetSetsInput.value = ex.targetSets;
    }

    renderRestTimer();
    renderSetPlan(ex);

    // 배너는 DOM이 아니라 state에서 렌더한다. 예전에는 여기서 무조건
    // 숨겼기 때문에 (a) 컨디션 배너가 같은 turn에 지워지고 (b) 대체 제안이
    // 다음 명령 한 번에 날아갔다.
    var pend = state.session.pendingSubstitute;
    if (pend && pend.exerciseId === ex.id) {
      el.sessionSubBanner.innerHTML = "<strong>" + pend.subName + "</strong>로 대체할까요?";
      el.sessionSubBanner.classList.add("show");
      el.sessionSubActions.classList.add("show");
    } else if (state.sessionSubMessage) {
      el.sessionSubBanner.textContent = state.sessionSubMessage;
      el.sessionSubBanner.classList.add("show");
      el.sessionSubActions.classList.remove("show");
      state.sessionSubMessage = null; // 취할 액션이 없는 안내라 일회성으로 소진
    } else {
      el.sessionSubBanner.classList.remove("show");
      el.sessionSubActions.classList.remove("show");
    }

    if (state.sessionCondMessage) {
      el.sessionCondBanner.textContent = state.sessionCondMessage;
      el.sessionCondBanner.classList.add("show");
    } else {
      el.sessionCondBanner.classList.remove("show");
    }
  }

  // "진행중"은 오직 지금 실제로 열려있는(currentPart/currentExercise) 종목만을 뜻한다.
  // 세트를 일부만 하고 다른 종목으로 넘어간 경우는 "일부 완료"로 따로 구분한다 —
  // 예전엔 둘 다 "진행중"으로 겹쳐서, 상세 패널의 "이동" 버튼이 (currentExercise가
  // 아닌데도) 비활성화되는 바람에 그 종목으로 돌아갈 수 없는 버그가 있었다.
  function computeExerciseStatus(partIdx, exIdx, ex) {
    if (partIdx === state.session.currentPart && exIdx === state.session.currentExercise) {
      return "진행중";
    }
    if (ex.targetSets > 0 && ex.sets.length >= ex.targetSets) return "완료";
    if (ex.sets.length > 0) return "일부 완료";
    return "예정";
  }

  function resolvePartQuery(query) {
    var q = (query || "").trim();
    if (!q) return null;
    for (var i = 0; i < state.session.parts.length; i++) {
      var name = state.session.parts[i].name;
      if (name === q || q.indexOf(name) !== -1 || name.indexOf(q) !== -1) {
        return { part: state.session.parts[i], idx: i };
      }
    }
    return null;
  }

  function resolveExerciseQuery(query) {
    var q = (query || "").trim();
    if (!q) return null;
    for (var pi = 0; pi < state.session.parts.length; pi++) {
      var exercises = state.session.parts[pi].exercises;
      for (var ei = 0; ei < exercises.length; ei++) {
        var ex = exercises[ei];
        var candidates = [ex.name];
        if (ex.substitutedFrom) candidates.push(ex.substitutedFrom);
        for (var c = 0; c < candidates.length; c++) {
          var name = candidates[c];
          if (name === q || q.indexOf(name) !== -1 || name.indexOf(q) !== -1) {
            return { ex: ex, partIdx: pi, exIdx: ei };
          }
        }
      }
    }
    return null;
  }

  function renderRoutineOverlay() {
    el.routineBody.textContent = "";
    state.session.parts.forEach(function (part, pIdx) {
      var section = document.createElement("div");
      section.className = "routine-part";
      section.setAttribute("data-part-index", String(pIdx));

      var heading = document.createElement("div");
      heading.className = "routine-part-name";
      heading.textContent = part.name;
      section.appendChild(heading);

      var list = document.createElement("div");
      list.className = "routine-ex-list";

      part.exercises.forEach(function (ex, eIdx) {
        var status = computeExerciseStatus(pIdx, eIdx, ex);
        // div + role=button: 펼친 상세 안에 삭제 <button>을 넣으려면 카드 자체는
        // <button>이면 안 된다(button 안에 button은 유효한 HTML이 아님).
        var card = document.createElement("div");
        card.setAttribute("role", "button");
        card.tabIndex = 0;
        card.className = "routine-ex";
        card.setAttribute("data-status", status);
        card.setAttribute("data-ex-id", ex.id);

        var row = document.createElement("div");
        row.className = "routine-ex-row";

        var handle = document.createElement("span");
        handle.className = "routine-ex-handle";
        handle.textContent = "⠿";
        handle.title = "드래그해서 순서 변경";
        handle.setAttribute("aria-hidden", "true");
        row.appendChild(handle);

        var nameEl = document.createElement("span");
        nameEl.className = "routine-ex-name";
        nameEl.textContent = ex.name;
        row.appendChild(nameEl);

        var statusEl = document.createElement("span");
        statusEl.className = "routine-ex-status";
        statusEl.setAttribute("data-status", status);
        statusEl.textContent = status;
        row.appendChild(statusEl);

        card.appendChild(row);

        attachExerciseDrag(handle, card, pIdx, list);

        var sub = document.createElement("div");
        sub.className = "routine-ex-sub";
        sub.textContent = ex.targetSets + "세트 × " + ex.targetReps + "회 · " + ex.sets.length + "/" + ex.targetSets + " 완료" +
          (ex.substitutedFrom ? " · 대체됨 (" + ex.substitutedFrom + " → " + ex.name + ")" : "");
        card.appendChild(sub);

        if (state.routineExpandedId === ex.id) {
          var detail = document.createElement("div");
          detail.className = "routine-ex-detail";

          var target = document.createElement("div");
          target.className = "set-row";
          var tlbl = document.createElement("span");
          tlbl.className = "lbl";
          tlbl.textContent = "목표";
          target.appendChild(tlbl);
          target.appendChild(document.createTextNode(ex.targetSets + "세트 × " + ex.targetReps + "회"));
          detail.appendChild(target);

          var restInfo = document.createElement("div");
          restInfo.className = "set-row";
          var rlbl = document.createElement("span");
          rlbl.className = "lbl";
          rlbl.textContent = "세트당 휴식";
          restInfo.appendChild(rlbl);
          restInfo.appendChild(document.createTextNode((ex.restSec || 90) + "초"));
          detail.appendChild(restInfo);

          if (ex.sets.length) {
            ex.sets.forEach(function (s, i) {
              var setRow = document.createElement("div");
              setRow.className = "set-row";
              setRow.textContent = (i + 1) + "세트: " + displayWeight(s.weight) + weightUnitLabel() + " × " + s.reps + "회";
              detail.appendChild(setRow);
              if (s.comment) {
                var setCmt = document.createElement("div");
                setCmt.className = "comment-row";
                setCmt.textContent = "메모: " + s.comment;
                detail.appendChild(setCmt);
              }
            });
          } else {
            var noneRow = document.createElement("div");
            noneRow.className = "comment-row";
            noneRow.textContent = "아직 기록된 세트가 없습니다.";
            detail.appendChild(noneRow);
          }

          if (ex.comments.length) {
            ex.comments.forEach(function (c) {
              var cRow = document.createElement("div");
              cRow.className = "comment-row";
              cRow.textContent = "메모: " + c.text;
              detail.appendChild(cRow);
            });
          }

          if (ex.setNotes) {
            Object.keys(ex.setNotes).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (key) {
              var nRow = document.createElement("div");
              nRow.className = "comment-row";
              nRow.textContent = (Number(key) + 1) + "세트 예정 메모: " + ex.setNotes[key];
              detail.appendChild(nRow);
            });
          }

          if (ex.substitutedFrom) {
            var subRow = document.createElement("div");
            subRow.className = "comment-row";
            subRow.textContent = "원래 종목: " + ex.substitutedFrom;
            detail.appendChild(subRow);
          }

          var detailActions = document.createElement("div");
          detailActions.className = "routine-ex-detail-actions";

          var goBtn = document.createElement("button");
          goBtn.type = "button";
          goBtn.className = "routine-ex-goto";
          goBtn.textContent = status === "진행중" ? "지금 진행중" : "이 종목으로 이동";
          if (status === "진행중") goBtn.disabled = true;
          goBtn.addEventListener("click", function (event) {
            event.stopPropagation();
            goToRoutineExercise(pIdx, eIdx);
          });
          detailActions.appendChild(goBtn);

          var deleteBtn = document.createElement("button");
          deleteBtn.type = "button";
          deleteBtn.className = "routine-ex-delete";
          if (part.exercises.length <= 1) {
            deleteBtn.disabled = true;
            deleteBtn.textContent = "이 파트의 마지막 종목이라 삭제할 수 없어요";
          } else {
            deleteBtn.textContent = "이 종목 삭제";
          }
          deleteBtn.addEventListener("click", function (event) {
            event.stopPropagation(); // 카드 자체의 클릭(종목 이동)으로 번지지 않게
            if (deleteBtn.getAttribute("data-armed") === "true") {
              deleteExercise(pIdx, eIdx);
              return;
            }
            deleteBtn.setAttribute("data-armed", "true");
            deleteBtn.textContent = "정말 삭제? 한 번 더";
            setTimeout(function () {
              if (deleteBtn.getAttribute("data-armed") === "true") {
                deleteBtn.setAttribute("data-armed", "false");
                deleteBtn.textContent = "이 종목 삭제";
              }
            }, 3000);
          });
          detailActions.appendChild(deleteBtn);
          detail.appendChild(detailActions);

          card.appendChild(detail);
        }

        card.addEventListener("click", function () {
          state.routineExpandedId = state.routineExpandedId === ex.id ? null : ex.id;
          renderRoutineOverlay();
        });
        card.addEventListener("keydown", function (event) {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            state.routineExpandedId = state.routineExpandedId === ex.id ? null : ex.id;
            renderRoutineOverlay();
          }
        });

        list.appendChild(card);
      });

      section.appendChild(list);

      if (state.routineAddingPart === pIdx) {
        section.appendChild(buildAddExerciseForm(pIdx));
      } else {
        var addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "routine-add-btn";
        addBtn.textContent = "+ " + part.name + "에 종목 추가";
        addBtn.addEventListener("click", function () {
          state.routineAddingPart = pIdx;
          renderRoutineOverlay();
        });
        section.appendChild(addBtn);
      }

      el.routineBody.appendChild(section);
    });
  }

  var exerciseDragActive = false;

  // 핸들을 눌러서 시작하는 드래그 정렬. 카드 자체를 "고스트"(반투명 자리표시자)로
  // 남겨 list 안에서 실시간으로 이동시키고, 화면에는 커서를 따라다니는 별도
  // 뜬 사본(floater)만 보여준다. 손을 떼면 그 시점의 DOM 순서를 실제 데이터에 반영한다.
  function attachExerciseDrag(handle, card, pIdx, list) {
    handle.addEventListener("click", function (event) {
      event.stopPropagation(); // 핸들 탭이 카드 펼치기로 번지지 않게
    });

    handle.addEventListener("pointerdown", function (event) {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (exerciseDragActive) return;
      event.preventDefault();
      event.stopPropagation();
      startExerciseDrag(event, card, pIdx, list);
    });
  }

  function startExerciseDrag(startEvent, card, pIdx, list) {
    exerciseDragActive = true;
    var part = state.session.parts[pIdx];
    var rect = card.getBoundingClientRect();
    var offsetX = startEvent.clientX - rect.left;
    var offsetY = startEvent.clientY - rect.top;

    var floater = card.cloneNode(true);
    floater.className = "routine-ex routine-ex-drag-floater";
    floater.style.width = rect.width + "px";
    floater.style.left = rect.left + "px";
    floater.style.top = rect.top + "px";
    document.body.appendChild(floater);

    card.classList.add("dragging-ghost");
    document.body.style.userSelect = "none";

    function onMove(event) {
      floater.style.left = (event.clientX - offsetX) + "px";
      floater.style.top = (event.clientY - offsetY) + "px";

      var pointerY = event.clientY;
      var siblings = Array.prototype.slice.call(list.children).filter(function (n) { return n !== card; });
      var target = null;
      var insertBefore = true;
      for (var i = 0; i < siblings.length; i++) {
        var r = siblings[i].getBoundingClientRect();
        var mid = r.top + r.height / 2;
        if (pointerY < mid) { target = siblings[i]; insertBefore = true; break; }
      }
      if (!target && siblings.length) { target = siblings[siblings.length - 1]; insertBefore = false; }

      if (target) {
        if (insertBefore) list.insertBefore(card, target);
        else list.insertBefore(card, target.nextSibling);
      }
    }

    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.removeChild(floater);
      card.classList.remove("dragging-ghost");
      document.body.style.userSelect = "";
      exerciseDragActive = false;

      var newOrderIds = Array.prototype.map.call(list.children, function (n) { return n.getAttribute("data-ex-id"); });
      var byId = {};
      part.exercises.forEach(function (ex) { byId[ex.id] = ex; });
      var reordered = newOrderIds.map(function (id) { return byId[id]; }).filter(Boolean);

      if (reordered.length === part.exercises.length) {
        var currentId = (pIdx === state.session.currentPart) ? part.exercises[state.session.currentExercise].id : null;
        part.exercises = reordered;
        if (currentId) {
          var newIdx = part.exercises.findIndex(function (ex) { return ex.id === currentId; });
          if (newIdx !== -1) state.session.currentExercise = newIdx;
        }
        saveSession();
      }
      renderRoutineOverlay();
      renderSession();
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  }

  function makeExerciseId(name) {
    return "custom_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
  }

  function addCustomExercise(partIdx, data) {
    var part = state.session.parts[partIdx];
    if (!part) return;
    part.exercises.push({
      id: makeExerciseId(data.name),
      name: data.name,
      isMain: false,
      targetSets: data.targetSets,
      targetReps: data.reps,
      restSec: data.restSec,
      sets: [],
      comments: [],
      setNotes: {},
      substitutedFrom: null
    });
    state.routineAddingPart = null;
    saveSession();
    renderRoutineOverlay();
    renderSession();
  }

  function deleteExercise(partIdx, exIdx) {
    var part = state.session.parts[partIdx];
    if (!part || part.exercises.length <= 1) return; // 파트는 최소 1종목 있어야 currentSessionExercise()가 안전

    part.exercises.splice(exIdx, 1);

    if (partIdx === state.session.currentPart) {
      if (state.session.currentExercise > exIdx) {
        state.session.currentExercise--;
      } else if (state.session.currentExercise >= part.exercises.length) {
        state.session.currentExercise = part.exercises.length - 1;
      }
      if (state.session.currentExercise === exIdx) {
        // 지금 진행 중이던 종목이 삭제된 경우: 그 종목에 딸려 있던 배너/타이머 정리
        state.session.pendingSubstitute = null;
        state.sessionCondMessage = null;
        state.sessionSubMessage = null;
        state.editingSetKey = null;
        stopRestCountdown();
      }
    }

    state.routineExpandedId = null;
    saveSession();
    renderRoutineOverlay();
    renderSession();
  }

  function buildAddExerciseForm(partIdx) {
    var form = document.createElement("div");
    form.className = "routine-add-form";

    var nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "routine-add-form-name";
    nameInput.placeholder = "종목 이름 (예: 인클라인 벤치프레스)";
    form.appendChild(nameInput);

    function numField(placeholder, value, small) {
      var inp = document.createElement("input");
      inp.type = "number";
      inp.inputMode = "numeric";
      inp.placeholder = placeholder;
      inp.value = String(value);
      if (small) inp.className = "routine-add-form-input-sm";
      clearOnFocus(inp);
      return inp;
    }

    var row = document.createElement("div");
    row.className = "routine-add-form-row";
    var setsInput = numField("세트", 3);
    var repsInput = numField("반복", 10, true);
    var restInput = numField("휴식(초)", 90);
    row.appendChild(setsInput);
    row.appendChild(repsInput);
    row.appendChild(restInput);
    form.appendChild(row);

    var actions = document.createElement("div");
    actions.className = "routine-add-form-actions";

    var saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "routine-add-save";
    saveBtn.textContent = "추가";
    saveBtn.addEventListener("click", function () {
      var name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }

      var sets = parseInt(setsInput.value, 10);
      if (isNaN(sets) || sets < 1) sets = 1;

      var reps = parseInt(repsInput.value, 10);
      if (isNaN(reps) || reps < 1) reps = 1;

      var rest = parseInt(restInput.value, 10);
      if (isNaN(rest) || rest < 0) rest = 90;

      addCustomExercise(partIdx, { name: name, targetSets: sets, reps: reps, restSec: rest });
    });

    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "routine-add-cancel";
    cancelBtn.textContent = "취소";
    cancelBtn.addEventListener("click", function () {
      state.routineAddingPart = null;
      renderRoutineOverlay();
    });

    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    form.appendChild(actions);

    requestAnimationFrame(function () { nameInput.focus(); });

    return form;
  }

  function openRoutineOverlay(opts) {
    state.routineOverlayOpen = true;
    var focusExercise = opts && opts.focusExercise;
    var focusPartIdx = opts && opts.focusPartIdx;
    if (focusExercise) state.routineExpandedId = focusExercise;
    renderRoutineOverlay();
    el.routineOverlay.classList.add("show");
    el.routineOverlay.setAttribute("aria-hidden", "false");

    var scrollTarget = null;
    if (focusExercise) {
      scrollTarget = el.routineBody.querySelector('[data-ex-id="' + focusExercise + '"]');
    } else if (focusPartIdx != null) {
      scrollTarget = el.routineBody.querySelector('[data-part-index="' + focusPartIdx + '"]');
    }
    if (scrollTarget) {
      el.routineBody.scrollTop = Math.max(0, scrollTarget.offsetTop - 8);
    }
  }

  function closeRoutineOverlay() {
    state.routineOverlayOpen = false;
    state.routineAddingPart = null;
    el.routineOverlay.classList.remove("show");
    el.routineOverlay.setAttribute("aria-hidden", "true");
  }

  function goToRoutineExercise(partIdx, exIdx) {
    if (partIdx !== state.session.currentPart || exIdx !== state.session.currentExercise) {
      state.session.currentPart = partIdx;
      state.session.currentExercise = exIdx;
      state.session.pendingSubstitute = null;
      state.sessionCondMessage = null;
      state.sessionSubMessage = null;
      state.editingSetKey = null;
      stopRestCountdown();
    }
    closeRoutineOverlay();
    saveSession();
    renderSession();
  }

  function renderSetPlan(ex) {
    el.sessionLog.textContent = "";
    var restSec = ex.restSec || 90;
    var totalRows = Math.max(ex.targetSets, ex.sets.length);

    for (var i = 0; i < totalRows; i++) {
      var doneSet = ex.sets[i];
      var row = document.createElement("div");
      row.className = "session-set";

      var head = document.createElement("div");
      head.className = "set-head";

      var labelSuffix = "";
      if (doneSet && i >= ex.targetSets) {
        labelSuffix = " (보너스)";
      } else if (!doneSet && i === ex.sets.length) {
        labelSuffix = " (진행중)"; // 다음에 기록될, 지금 실제로 하고 있는 세트
      } else if (!doneSet) {
        labelSuffix = " (예정)";
      }
      var label = document.createElement("span");
      label.className = "set-label";
      label.textContent = (i + 1) + "세트" + labelSuffix + ":";
      head.appendChild(label);

      var fields = document.createElement("span");
      fields.className = "set-fields";

      var lastKnown = ex.sets[ex.sets.length - 1];
      var weightInput = document.createElement("input");
      weightInput.type = "number";
      weightInput.inputMode = "decimal";
      weightInput.step = tweaks.unit === "lb" ? "1" : "0.5";
      weightInput.className = "set-num-input set-weight-input";
      weightInput.setAttribute("data-set-key", String(i));
      weightInput.placeholder = weightUnitLabel();
      weightInput.value = doneSet ? displayWeight(doneSet.weight) : (lastKnown ? displayWeight(lastKnown.weight) : "");
      clearOnFocus(weightInput);
      fields.appendChild(weightInput);

      var kgTimes = document.createElement("span");
      kgTimes.className = "set-unit";
      kgTimes.textContent = weightUnitLabel() + " ×";
      fields.appendChild(kgTimes);

      var repsInput = document.createElement("input");
      repsInput.type = "number";
      repsInput.inputMode = "numeric";
      repsInput.step = "1";
      repsInput.className = "set-num-input set-reps-input";
      repsInput.setAttribute("data-set-key", String(i));
      repsInput.placeholder = "회수";
      repsInput.value = doneSet ? doneSet.reps : ex.targetReps;
      clearOnFocus(repsInput);
      fields.appendChild(repsInput);

      var repsUnit = document.createElement("span");
      repsUnit.className = "set-unit";
      repsUnit.textContent = "회";
      fields.appendChild(repsUnit);

      var isLastLogged = doneSet && i === ex.sets.length - 1;
      var checkBtn = document.createElement("button");
      checkBtn.type = "button";
      checkBtn.className = "set-check-btn";
      checkBtn.setAttribute("data-set-key", String(i));
      if (doneSet) {
        checkBtn.setAttribute("data-done", "true");
        checkBtn.textContent = "✓ 완료";
        if (isLastLogged) {
          checkBtn.setAttribute("data-action", "uncomplete");
          checkBtn.title = "이 세트 완료 취소";
        } else {
          checkBtn.setAttribute("data-action", "locked");
          checkBtn.setAttribute("data-locked", "true");
          checkBtn.title = "먼저 뒤 세트를 취소해야 이 세트를 되돌릴 수 있어요";
        }
      } else {
        checkBtn.setAttribute("data-done", "false");
        checkBtn.setAttribute("data-action", "complete");
        checkBtn.textContent = "완료 체크";
        checkBtn.title = "지금 보이는 무게·반복수로 이 세트를 완료 처리";
      }
      fields.appendChild(checkBtn);

      head.appendChild(fields);

      // 완료 여부와 상관없이 모든 세트에 메모 버튼을 둔다. 아직 안 한 세트의
      // 메모는 ex.setNotes에 예약해뒀다가 그 세트가 실제로 기록될 때 옮겨 붙는다.
      var existingNote = doneSet ? doneSet.comment : (ex.setNotes && ex.setNotes[String(i)]);
      var memoBtn = document.createElement("button");
      memoBtn.type = "button";
      memoBtn.className = "set-memo-btn";
      memoBtn.setAttribute("data-set-key", String(i));
      memoBtn.textContent = existingNote ? "메모 수정" : "메모";
      head.appendChild(memoBtn);
      row.appendChild(head);

      if (state.editingSetKey === String(i)) {
        var input = document.createElement("input");
        input.type = "text";
        input.className = "set-memo-input";
        input.setAttribute("data-set-key", String(i));
        input.placeholder = "이 세트 메모";
        input.value = existingNote || "";
        row.appendChild(input);
        (function (inputEl) {
          requestAnimationFrame(function () {
            inputEl.focus();
            inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
          });
        })(input);
      } else if (existingNote) {
        var cmt = document.createElement("div");
        cmt.className = "set-memo-text";
        cmt.textContent = existingNote;
        row.appendChild(cmt);
      }

      if (!doneSet) {
        row.classList.add(i === ex.sets.length ? "session-set-next" : "session-set-future");
      }

      el.sessionLog.appendChild(row);

      if (i < totalRows - 1) {
        var restRow = document.createElement("div");
        restRow.className = "session-rest-hint";
        restRow.textContent = "쉬는시간 " + restSec + "초";
        el.sessionLog.appendChild(restRow);
      }
    }

    ex.comments.slice().reverse().forEach(function (c) {
      var row = document.createElement("div");
      row.className = "session-set comment";
      row.textContent = c.text;
      el.sessionLog.appendChild(row);
    });
  }

  function findSetByKey(key) {
    var ex = currentSessionExercise();
    var idx = Number(key);
    if (!ex.sets[idx]) return null;
    return { ex: ex, set: ex.sets[idx] };
  }

  function readRowFieldValue(ex, idx, field) {
    var selector = field === "weight" ? ".set-weight-input" : ".set-reps-input";
    var input = el.sessionLog.querySelector(selector + '[data-set-key="' + idx + '"]');
    if (input) {
      var num = parseFloat(input.value);
      if (!isNaN(num)) return field === "reps" ? Math.round(num) : toStoredKg(num);
    }
    if (field === "reps") return ex.targetReps;
    var prev = ex.sets[ex.sets.length - 1];
    return prev ? prev.weight : 0;
  }

  // 세트가 아직 완료되기 전에 미리 달아둔 메모(ex.setNotes)를 그 세트가
  // 실제로 생성되는 순간(완료 체크·음성 SET_LOG·건너뛴 세트 자동 채움) 가져와서
  // 소비한다. 있으면 반환하고 setNotes에서는 지운다.
  function takePendingNote(ex, idx) {
    var key = String(idx);
    if (ex.setNotes && ex.setNotes[key]) {
      var note = ex.setNotes[key];
      delete ex.setNotes[key];
      return note;
    }
    return null;
  }

  function ensureSetsUpTo(ex, idx) {
    while (ex.sets.length < idx) {
      var i = ex.sets.length;
      var skippedSet = {
        weight: readRowFieldValue(ex, i, "weight"),
        reps: readRowFieldValue(ex, i, "reps"),
        ts: new Date().toISOString()
      };
      var pendingForSkipped = takePendingNote(ex, i);
      if (pendingForSkipped) skippedSet.comment = pendingForSkipped;
      ex.sets.push(skippedSet);
    }
  }

  // 메모는 세트 완료 여부와 무관하게 언제든 달 수 있다: 이미 기록된 세트면
  // 그 세트에 바로 붙이고, 아직 안 한 세트면 ex.setNotes에 예약해뒀다가
  // 나중에 그 세트가 실제로 기록될 때 옮겨 붙는다(takePendingNote).
  function commitSetComment(input) {
    var key = input.getAttribute("data-set-key");
    var ex = currentSessionExercise();
    var text = input.value.trim();
    var found = findSetByKey(key);
    if (found) {
      found.set.comment = text;
    } else {
      if (!ex.setNotes) ex.setNotes = {};
      if (text) ex.setNotes[key] = text; else delete ex.setNotes[key];
    }
    saveSession();
    state.editingSetKey = null;
    renderSession();
  }

  function commitSetRowData(row) {
    if (!row) return;
    var weightInput = row.querySelector(".set-weight-input");
    var repsInput = row.querySelector(".set-reps-input");
    if (!weightInput || !repsInput) return;
    var idx = Number(weightInput.getAttribute("data-set-key"));
    var ex = currentSessionExercise();
    var weightNum = parseFloat(weightInput.value);
    var repsNum = parseFloat(repsInput.value);
    ensureSetsUpTo(ex, idx);
    var existing = ex.sets[idx] || { ts: new Date().toISOString() };
    existing.weight = !isNaN(weightNum) ? toStoredKg(weightNum) : (existing.weight != null ? existing.weight : readRowFieldValue(ex, idx, "weight"));
    existing.reps = !isNaN(repsNum) ? Math.round(repsNum) : (existing.reps != null ? existing.reps : readRowFieldValue(ex, idx, "reps"));
    if (!existing.comment) {
      var pendingNote = takePendingNote(ex, idx);
      if (pendingNote) existing.comment = pendingNote;
    }
    ex.sets[idx] = existing;
    saveSession();
  }

  function commitSetRow(row) {
    commitSetRowData(row);
    renderSession();
  }

  // 클릭만으로 세트를 완료/취소하는 경로. 음성·텍스트 명령과 별개로,
  // 화면에 보이는 무게·반복수 값 그대로 특정 세트를 콕 집어 완료 처리한다.
  function handleSetCheckClick(btn) {
    var action = btn.getAttribute("data-action");
    if (action === "locked") return; // 중간 세트는 뒤 세트부터 순서대로 취소해야 함

    var ex = currentSessionExercise();

    if (action === "complete") {
      var row = btn.closest(".session-set");
      commitSetRowData(row);
      startRestCountdown(ex.restSec || 90);
      renderSession();
      return;
    }

    if (action === "uncomplete") {
      var idx = Number(btn.getAttribute("data-set-key"));
      if (idx === ex.sets.length - 1) {
        ex.sets.pop();
        stopRestCountdown();
        saveSession();
        renderSession();
      }
    }
  }

  function startRestCountdown(restSec) {
    clearInterval(state.restIntervalId);
    state.restEndsAt = Date.now() + restSec * 1000;
    renderRestTimer();
    state.restIntervalId = setInterval(renderRestTimer, 1000);
  }

  function stopRestCountdown() {
    clearInterval(state.restIntervalId);
    state.restIntervalId = null;
    state.restEndsAt = null;
    if (el.sessionRestTimer) {
      el.sessionRestTimer.classList.remove("show", "done");
      el.sessionRestTimer.textContent = "";
    }
  }

  function renderRestTimer() {
    if (!el.sessionRestTimer) return;
    if (!state.restEndsAt) {
      el.sessionRestTimer.classList.remove("show", "done");
      return;
    }
    var remaining = Math.round((state.restEndsAt - Date.now()) / 1000);
    if (remaining <= 0) {
      el.sessionRestTimer.textContent = restDoneText();
      el.sessionRestTimer.classList.add("show", "done");
      clearInterval(state.restIntervalId);
      state.restIntervalId = null;
      setTimeout(function () {
        state.restEndsAt = null;
        if (el.sessionRestTimer) el.sessionRestTimer.classList.remove("show", "done");
      }, 4000);
      return;
    }
    el.sessionRestTimer.classList.remove("done");
    el.sessionRestTimer.classList.add("show");
    el.sessionRestTimer.textContent = restCountdownText(remaining);
  }

  function hasAnyRecordedSets() {
    return state.session.parts.some(function (part) {
      return part.exercises.some(function (ex) { return ex.sets.length > 0; });
    });
  }

  // 운동 종료 버튼과 음성/텍스트 "오늘 끝" 명령이 공유하는 단일 종료 경로.
  function endWorkoutSession() {
    if (!hasAnyRecordedSets()) {
      state.sessionSubMessage = "아직 기록된 세트가 없어서 종료할 게 없어요.";
      renderSession();
      return;
    }
    renderSessionSummaryExport();
  }

  // 세트 메모·종목 메모·아직 완료 안 한 세트에 예약된 메모까지 전부 모아서,
  // 각 줄이 어떤 파트/종목/세트인지 스스로 밝히는 태그를 붙인다.
  // 나중에 이 줄 하나만 메모장에 따로 붙여넣어도 무슨 내용인지 알 수 있게 하기 위함.
  function collectAllMemos() {
    var memos = [];
    state.session.parts.forEach(function (part) {
      part.exercises.forEach(function (ex) {
        ex.sets.forEach(function (s, i) {
          if (s.comment) {
            memos.push({ tag: part.name + " · " + ex.name + " · " + (i + 1) + "세트", text: s.comment });
          }
        });
        ex.comments.forEach(function (c) {
          memos.push({ tag: part.name + " · " + ex.name, text: c.text });
        });
        if (ex.setNotes) {
          Object.keys(ex.setNotes).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (key) {
            memos.push({ tag: part.name + " · " + ex.name + " · " + (Number(key) + 1) + "세트 (예정)", text: ex.setNotes[key] });
          });
        }
      });
    });
    return memos;
  }

  function renderSessionSummaryExport() {
    var lines = [];
    var dateLabel = new Date().toISOString().slice(0, 10);
    lines.push("LiftVoice 세션 요약 — " + dateLabel);
    lines.push("");

    var totalSets = 0;
    var touchedExercises = 0;

    state.session.parts.forEach(function (part) {
      var partLines = [];
      part.exercises.forEach(function (ex) {
        if (!ex.sets.length && !ex.comments.length) return;
        touchedExercises++;
        var label = ex.name + (ex.substitutedFrom ? " (원래 종목: " + ex.substitutedFrom + ")" : "");
        partLines.push(label + " — " + ex.sets.length + "/" + ex.targetSets + "세트");
        ex.sets.forEach(function (s, i) {
          totalSets++;
          var setLine = "  " + (i + 1) + "세트 " + displayWeight(s.weight) + weightUnitLabel() + " x " + s.reps + "회";
          if (s.comment) setLine += "  (" + s.comment + ")";
          partLines.push(setLine);
        });
        ex.comments.forEach(function (c) {
          partLines.push("  메모: " + c.text);
        });
      });
      if (!partLines.length) return; // 손도 안 댄 파트는 요약에서 생략
      lines.push("=== " + part.name + " ===");
      lines.push.apply(lines, partLines);
      lines.push("");
    });

    lines.push("--- 요약 ---");
    lines.push("완료 종목: " + touchedExercises + "개 · 완료 세트: " + totalSets + "개");

    var memos = collectAllMemos();
    if (memos.length) {
      lines.push("");
      lines.push("--- 메모 모음 (메모장에 따로 붙여넣어도 되게 태그 포함) ---");
      memos.forEach(function (m) {
        lines.push("[" + m.tag + "] " + m.text);
      });
    }

    var text = lines.join("\n");
    el.exportBox.textContent = text;
    el.exportBox.classList.add("show");

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        el.btnExport.textContent = "복사됨";
        setTimeout(function () { el.btnExport.textContent = "세션 요약 보기 / 복사"; }, 1600);
      }, function () { /* clipboard blocked: text is on screen to select */ });
    }
  }

  function advanceSessionExercise() {
    var part = state.session.parts[state.session.currentPart];
    if (state.session.currentExercise < part.exercises.length - 1) {
      state.session.currentExercise++;
    } else if (state.session.currentPart < state.session.parts.length - 1) {
      state.session.currentPart++;
      state.session.currentExercise = 0;
    }
    // 이전 종목에 대한 대체 제안/컨디션 배너는 새 종목에서 의미가 없다.
    state.session.pendingSubstitute = null;
    state.sessionCondMessage = null;
    state.sessionSubMessage = null;
    state.editingSetKey = null;
    stopRestCountdown();
    saveSession();
    renderSession();
  }

  var SESSION_SUBSTITUTES = {
    squat_set2: { name: "고블릿 스쿼트", why: "랙이 막혀 있어도 덤벨만 있으면 가능" },
    squat_set3: { name: "고블릿 스쿼트", why: "랙이 막혀 있어도 덤벨만 있으면 가능" },
    leg_press: { name: "핵 스쿼트", why: "레그프레스 자리 없을 때 같은 squat 패턴" },
    stiff_leg_deadlift: { name: "덤벨 루마니안 데드리프트", why: "바벨 없을 때 같은 hinge 패턴" }
  };

  function showSubstituteSuggestion(ex) {
    var sub = SESSION_SUBSTITUTES[ex.id];
    if (!sub) {
      state.session.pendingSubstitute = null;
      state.sessionSubMessage = toneCopy("noSub");
      return;
    }
    // DOM이 아니라 state에 담아 renderSession()이 매번 다시 그리게 한다.
    state.session.pendingSubstitute = { exerciseId: ex.id, subName: sub.name };
    state.sessionSubMessage = null;
  }

  function applySubstitute() {
    var ex = currentSessionExercise();
    var sub = SESSION_SUBSTITUTES[ex.id];
    state.session.pendingSubstitute = null;
    state.editingSetKey = null;
    stopRestCountdown();
    if (!sub) {
      saveSession();
      renderSession();
      return;
    }
    ex.substitutedFrom = ex.name;
    ex.name = sub.name;
    saveSession();
    renderSession();
  }

  function handleSessionCommand(text, preClassified) {
    var cmd = preClassified || classifyCommand(text);
    var ex = currentSessionExercise();

    switch (cmd.type) {
      case "SET_ADJUST_WEIGHT": {
        var lastSet = ex.sets[ex.sets.length - 1];
        if (!lastSet) return;
        lastSet.weight = cmd.direction === "add"
          ? lastSet.weight + cmd.amountKg
          : lastSet.weight - cmd.amountKg;
        break;
      }
      case "SET_ADJUST_REPS": {
        var last = ex.sets[ex.sets.length - 1];
        if (!last) return;
        last.reps = cmd.reps;
        break;
      }
      case "COMMENT":
        if (ex.sets.length) {
          var lastLoggedSet = ex.sets[ex.sets.length - 1];
          lastLoggedSet.comment = lastLoggedSet.comment
            ? lastLoggedSet.comment + " / " + cmd.text
            : cmd.text;
        } else {
          ex.comments.push({ text: cmd.text, ts: new Date().toISOString() });
        }
        break;
      case "CONDITION":
        ex.comments.push({ text: "[컨디션] " + cmd.text, ts: new Date().toISOString() });
        state.sessionCondMessage = toneCopy("condition");
        break;
      case "SUBSTITUTE_REQUEST":
        showSubstituteSuggestion(ex);
        break; // 배너는 state에 있으므로 renderSession()이 안전하게 다시 그린다
      case "TARGET_ADJUST":
        if (cmd.mode === "set") {
          ex.targetSets = cmd.targetSets;
        } else {
          ex.targetSets = Math.max(1, ex.targetSets + cmd.delta);
        }
        break;
      case "NEXT_EXERCISE":
        advanceSessionExercise();
        return; // advanceSessionExercise가 자체적으로 save/render 처리
      case "ROUTINE_OVERVIEW":
        openRoutineOverlay();
        return;
      case "PART_REMAINING": {
        var partMatch = resolvePartQuery(cmd.partQuery);
        openRoutineOverlay(partMatch ? { focusPartIdx: partMatch.idx } : null);
        return;
      }
      case "EXERCISE_QUERY": {
        var exMatch = resolveExerciseQuery(cmd.nameQuery);
        if (exMatch) {
          openRoutineOverlay({ focusExercise: exMatch.ex.id });
        } else {
          state.sessionSubMessage = "'" + cmd.nameQuery + "' 종목을 찾지 못했어요.";
          renderSession();
        }
        return;
      }
      case "ROUTINE_SWITCH": {
        var matchedName = ROUTINE_NAME_LIST.filter(function (n) { return n === cmd.routineName; })[0];
        if (!matchedName) {
          state.sessionSubMessage = "'" + cmd.routineName + "' 루틴을 찾지 못했어요. (저장된 루틴: " + ROUTINE_NAME_LIST.join(", ") + ")";
          renderSession();
          return;
        }
        if (matchedName === state.session.routineName) {
          state.sessionSubMessage = "이미 '" + matchedName + "' 루틴이에요.";
          renderSession();
          return;
        }
        switchRoutine(matchedName);
        return; // switchRoutine이 자체적으로 save/render 처리
      }
      case "SESSION_END":
        endWorkoutSession();
        return;
      case "SET_LOG": {
        var weight = cmd.weightKg;
        if (weight == null) {
          var prevSet = ex.sets[ex.sets.length - 1];
          weight = prevSet ? prevSet.weight : null;
        }
        if (weight == null) {
          state.sessionSubMessage = "이 종목 첫 세트는 무게도 말해주세요 (예: \"45키로 8개\").";
          break;
        }
        var newSet = { weight: weight, reps: cmd.reps, ts: new Date().toISOString() };
        var pendingNoteForNewSet = takePendingNote(ex, ex.sets.length);
        if (pendingNoteForNewSet) newSet.comment = pendingNoteForNewSet;
        ex.sets.push(newSet);
        startRestCountdown(ex.restSec || 90);
        break;
      }
      default:
        return; // UNRECOGNIZED — 트랜스크립트에만 표시되고 세션 상태는 안 바뀐다
    }

    saveSession();
    renderSession();
  }

  // 음성 인식 결과와 텍스트 직접 입력이 완전히 같은 경로를 타게 하는 공용 처리기.
  // 마이크 없이(또는 인식이 안 될 때) 같은 명령을 텍스트로 쳐도 동일하게 동작한다.
  function processFinalText(rawText) {
    var finalText = rawText.trim();
    if (!finalText) return;
    renderTranscript(finalText, "");
    handleSessionCommand(finalText);
  }

  /* ---------- engine ---------- */

  function buildRecognizer() {
    var r = new SR();
    r.lang = "ko-KR";
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onstart = function () {
      state.running = true;
      clearTimeout(startWatchdog);
      setStatus("듣는 중", true);
    };

    r.onresult = function (event) {
      var finalText = "";
      var interimText = "";
      for (var i = event.resultIndex; i < event.results.length; i++) {
        var res = event.results[i];
        if (res.isFinal) {
          finalText += res[0].transcript;
        } else {
          interimText += res[0].transcript;
        }
      }
      if (finalText) {
        processFinalText(finalText);
      } else {
        renderTranscript("", interimText);
      }
    };

    r.onerror = function (event) {
      var code = event.error;
      if (code === "no-speech" || code === "aborted") {
        // Benign: onend will restart if the user is still listening.
        return;
      }
      if (code === "not-allowed" || code === "service-not-allowed") {
        stop();
        showBanner(
          "<strong>마이크 권한이 거부되었습니다.</strong> 주소창의 자물쇠 아이콘에서 마이크를 허용한 뒤 다시 시도하세요.",
          true
        );
        return;
      }
      if (code === "audio-capture") {
        stop();
        showBanner("<strong>마이크를 찾을 수 없습니다.</strong> 다른 앱이 마이크를 쓰고 있는지 확인하세요.", true);
        return;
      }
      if (code === "network") {
        stop();
        showBanner("<strong>네트워크 오류입니다.</strong> 구글 음성인식은 인터넷 연결이 필요합니다. 연결을 확인하고 다시 시도하세요.", true);
        return;
      }
      stop();
      showBanner("<strong>인식 오류: " + code + "</strong> 다시 시도해 주세요.", true);
    };

    // Chrome ends the session on its own after silence, even with
    // continuous = true. Restart whenever the user still intends to listen.
    r.onend = function () {
      state.running = false;
      if (state.listening) {
        try {
          r.start();
        } catch (e) {
          // start() throws if the engine has not fully released yet; retry shortly.
          setTimeout(function () {
            if (state.listening && !state.running) {
              try { r.start(); } catch (e2) { stop(); }
            }
          }, 300);
        }
      } else {
        setStatus("대기 중", false);
      }
    };

    return r;
  }

  function start() {
    if (state.listening) return;
    state.listening = true;
    el.rec.setAttribute("data-on", "true");
    el.recLabel.textContent = "정지";
    setStatus("연결 중", true);
    el.banner.classList.remove("show");

    try {
      rec.start();
    } catch (e) {
      // InvalidStateError means the previous session has not released yet;
      // anything else is a real failure the user needs to see.
      if (e && e.name === "InvalidStateError") {
        return;
      }
      stop();
      showBanner("<strong>음성인식을 시작할 수 없습니다: " + (e && e.name) + "</strong> " +
        (e && e.message ? e.message : ""), true);
      return;
    }

    // onstart is not guaranteed to fire — in an in-app WebView the engine
    // accepts start() and then goes silent. Never leave the UI on "연결 중".
    clearTimeout(startWatchdog);
    startWatchdog = setTimeout(function () {
      if (state.listening && !state.running) {
        stop();
        showBanner(
          "<strong>음성인식 엔진이 응답하지 않습니다.</strong> " +
          "앱 안의 화면에서 열었다면 <strong>Chrome</strong>으로 다시 열어 주세요. " +
          "Chrome인데도 계속된다면 인터넷 연결과 마이크 권한을 확인하세요.",
          true
        );
      }
    }, 6000);
  }

  function stop() {
    if (!state.listening) {
      setStatus("대기 중", false);
      return;
    }
    state.listening = false;
    clearTimeout(startWatchdog);
    el.rec.setAttribute("data-on", "false");
    el.recLabel.textContent = "녹음 시작";
    setStatus("대기 중", false);
    try {
      rec.stop();
    } catch (e) { /* engine already stopped */ }
  }

  function toggle() {
    if (state.listening) stop(); else start();
  }

  /* ---------- wiring ---------- */

  el.rec.addEventListener("click", toggle);

  function submitTypedCommand() {
    var text = el.typeInput.value;
    processFinalText(text);
    el.typeInput.value = "";
  }
  el.btnTypeSend.addEventListener("click", submitTypedCommand);
  el.typeInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      submitTypedCommand();
    }
  });

  el.btnSubApply.addEventListener("click", function () {
    applySubstitute();
  });

  el.btnSubDismiss.addEventListener("click", function () {
    state.session.pendingSubstitute = null;
    state.sessionSubMessage = null;
    saveSession();
    renderSession();
  });

  el.btnRoutineOverview.addEventListener("click", function () {
    openRoutineOverlay();
  });

  clearOnFocus(el.sessionRestInput);
  clearOnFocus(el.sessionTargetSetsInput);

  el.sessionRestInput.addEventListener("change", function () {
    var ex = currentSessionExercise();
    var val = parseInt(el.sessionRestInput.value, 10);
    if (!isNaN(val) && val >= 0) {
      ex.restSec = val;
      saveSession();
    }
    renderSession();
  });

  el.sessionTargetSetsInput.addEventListener("change", function () {
    var ex = currentSessionExercise();
    var val = parseInt(el.sessionTargetSetsInput.value, 10);
    if (!isNaN(val) && val >= 1) {
      ex.targetSets = val;
      saveSession();
    }
    renderSession();
  });

  el.btnSessionEnd.addEventListener("click", endWorkoutSession);

  el.routineSelect.addEventListener("change", function () {
    var name = el.routineSelect.value;
    if (name === state.session.routineName) return;
    switchRoutine(name);
  });

  el.btnRoutineClose.addEventListener("click", closeRoutineOverlay);
  el.routineBackdrop.addEventListener("click", closeRoutineOverlay);

  function openHelpOverlay() {
    el.helpOverlay.classList.add("show");
    el.helpOverlay.setAttribute("aria-hidden", "false");
  }
  function closeHelpOverlay() {
    el.helpOverlay.classList.remove("show");
    el.helpOverlay.setAttribute("aria-hidden", "true");
  }
  el.btnHelpOpen.addEventListener("click", openHelpOverlay);
  el.btnHelpClose.addEventListener("click", closeHelpOverlay);
  el.helpBackdrop.addEventListener("click", closeHelpOverlay);

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    if (state.routineOverlayOpen) closeRoutineOverlay();
    if (el.helpOverlay.classList.contains("show")) closeHelpOverlay();
  });

  el.sessionLog.addEventListener("click", function (event) {
    var checkBtn = event.target.closest(".set-check-btn");
    if (checkBtn) {
      handleSetCheckClick(checkBtn);
      return;
    }
    var memoBtn = event.target.closest(".set-memo-btn");
    if (!memoBtn) return;
    var key = memoBtn.getAttribute("data-set-key");
    var exForMemo = currentSessionExercise();
    if (exForMemo.sets[Number(key)]) {
      // 이미 완료된 세트: 메모창을 열기 전에 화면에 보이는 무게·반복 수정값도 같이 반영
      commitSetRowData(memoBtn.closest(".session-set"));
    }
    // 아직 완료 안 한 세트는 여기서 commitSetRowData를 부르지 않는다 —
    // 메모만 달려고 눌렀는데 세트가 조기 완료 처리되면 안 되니까.
    state.editingSetKey = state.editingSetKey === key ? null : key;
    renderSession();
  });

  el.sessionLog.addEventListener("focusout", function (event) {
    var memoInput = event.target.closest(".set-memo-input");
    var weightInput = event.target.closest(".set-weight-input");
    var repsInput = event.target.closest(".set-reps-input");
    var input = memoInput || weightInput || repsInput;
    if (!input) return;
    var row = input.closest(".session-set");
    var next = event.relatedTarget;
    if (row && next && row.contains(next)) return; // focus moved within the same row - keep editing
    if (memoInput) { commitSetComment(memoInput); return; }
    commitSetRow(row);
  });

  el.sessionLog.addEventListener("keydown", function (event) {
    var input = event.target.closest(".set-memo-input, .set-weight-input, .set-reps-input");
    if (input && event.key === "Enter") {
      event.preventDefault();
      input.blur();
    }
  });

  // Backgrounding the page tears down the audio session; stop cleanly
  // rather than leaving the UI stuck on "듣는 중".
  document.addEventListener("visibilitychange", function () {
    if (document.hidden && state.listening) stop();
  });

  el.btnExport.addEventListener("click", renderSessionSummaryExport);

  // 지금 활성 루틴(파트)에서 기록한 세트/메모만 지운다. 다른 루틴이나 종목
  // 구성은 그대로 둔다 — 다음에 같은 파트를 또 할 때 지난 기록이 안 섞이게
  // 하는 용도다("운동 종료"는 요약만 내보내고 초기화는 안 하므로 수동으로 누른다).
  el.btnClear.addEventListener("click", function () {
    var hasData = state.session.parts.some(function (part) {
      return part.exercises.some(function (ex) { return ex.sets.length || ex.comments.length; });
    });
    if (!hasData) return;
    if (el.btnClear.getAttribute("data-armed") === "true") {
      state.session.parts.forEach(function (part) {
        part.exercises.forEach(function (ex) {
          ex.sets = [];
          ex.comments = [];
          ex.setNotes = {};
        });
      });
      saveSession();
      renderSession();
      el.exportBox.classList.remove("show");
      el.btnClear.textContent = "이 루틴 기록 초기화";
      el.btnClear.removeAttribute("data-armed");
      return;
    }
    el.btnClear.textContent = "정말 초기화? 한 번 더";
    el.btnClear.setAttribute("data-armed", "true");
    setTimeout(function () {
      el.btnClear.textContent = "이 루틴 기록 초기화";
      el.btnClear.removeAttribute("data-armed");
    }, 3000);
  });

  /* ---------- boot ---------- */

  state.session = loadSession();
  loadTweaks();
  applyTweaks();
  syncTweaksUI();
  renderSession();

  document.getElementById("tweaks-toggle").addEventListener("click", function () {
    document.getElementById("tweaks-panel").classList.add("show");
    document.getElementById("tweaks-panel").setAttribute("aria-hidden", "false");
    this.style.display = "none";
  });
  document.getElementById("tweaks-close").addEventListener("click", function () {
    document.getElementById("tweaks-panel").classList.remove("show");
    document.getElementById("tweaks-panel").setAttribute("aria-hidden", "true");
    document.getElementById("tweaks-toggle").style.display = "";
  });
  document.getElementById("tweaks-vibe").addEventListener("click", function (event) {
    var btn = event.target.closest(".tweaks-opt");
    if (!btn) return;
    tweaks.vibe = btn.getAttribute("data-vibe-opt");
    saveTweaks();
    applyTweaks();
    syncTweaksUI();
  });
  document.getElementById("tweaks-tone").addEventListener("click", function (event) {
    var btn = event.target.closest(".tweaks-opt");
    if (!btn) return;
    tweaks.tone = btn.getAttribute("data-tone-opt");
    saveTweaks();
    applyTweaks();
    syncTweaksUI();
  });
  document.getElementById("tweaks-unit").addEventListener("click", function (event) {
    var btn = event.target.closest(".tweaks-opt");
    if (!btn) return;
    tweaks.unit = btn.getAttribute("data-unit-opt");
    saveTweaks();
    syncTweaksUI();
    renderSession();
  });
  document.getElementById("tweaks-focus").addEventListener("click", function () {
    tweaks.focus = !tweaks.focus;
    saveTweaks();
    applyTweaks();
    syncTweaksUI();
  });

  // Android WebView exposes SpeechRecognition but never fires its events,
  // so this must be checked before the constructor test below.
  if (/;\s*wv[;)]/.test(navigator.userAgent)) {
    el.rec.disabled = true;
    el.recLabel.textContent = "Chrome에서 열어 주세요";
    setStatus("사용 불가", false);
    showBanner(
      "<strong>앱 내장 화면에서는 음성인식이 동작하지 않습니다.</strong> " +
      "우측 상단 메뉴의 <strong>브라우저에서 열기</strong>로 <strong>Chrome</strong>에서 열어 주세요.",
      true
    );
    return;
  }

  if (!SR) {
    el.rec.disabled = true;
    el.recLabel.textContent = "지원되지 않음";
    setStatus("사용 불가", false);
    showBanner(
      "<strong>이 브라우저는 음성인식을 지원하지 않습니다.</strong> 갤럭시 S24에서는 <strong>Chrome</strong>으로 열어 주세요. (삼성 인터넷·Firefox는 미지원)",
      true
    );
    return;
  }

  if (!window.isSecureContext) {
    el.rec.disabled = true;
    setStatus("사용 불가", false);
    showBanner("<strong>보안 연결(HTTPS)이 아닙니다.</strong> 마이크를 쓸 수 없습니다.", true);
    return;
  }

  (function runSelfTests() {
    var r = selfTestCommands();
    if (r.fail) {
      console.error("[LiftVoice] self-test failures:", r.failures);
    } else {
      console.log("[LiftVoice] self-test OK (" + r.pass + " cases)");
    }
  })();

  rec = buildRecognizer();
})();
