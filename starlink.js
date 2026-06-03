const predict = require("sat-timings");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const LOCATIONS = [
  { name: "대전", lat: 36.3504, lon: 127.3845 },
  { name: "용인", lat: 37.2411, lon: 127.1776 },
];

const TLE_URL =
  "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=json";

const MAX_BRIGHTNESS = 2.5;
const MIN_ELEVATION = 40;
const MAX_RESULTS_PER_CITY = 3;
const DUPLICATE_TIME_MINUTES = 8;

function formatKoreanTime(epochSec) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).format(new Date(epochSec * 1000));
}

function dirKo(text = "") {
  const map = {
    north: "북",
    northeast: "북동",
    east: "동",
    southeast: "남동",
    south: "남",
    southwest: "남서",
    west: "서",
    northwest: "북서",
  };
  return map[text.toLowerCase()] || text;
}

async function getCloudCover(lat, lon, epochSec) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=cloud_cover&timezone=Asia%2FSeoul&forecast_days=3`;

  const data = await fetch(url).then((r) => r.json());

  const target = new Date(epochSec * 1000);
  const targetHour =
    target.getFullYear() +
    "-" +
    String(target.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(target.getDate()).padStart(2, "0") +
    "T" +
    String(target.getHours()).padStart(2, "0") +
    ":00";

  const idx = data.hourly.time.indexOf(targetHour);
  if (idx === -1) return null;

  return data.hourly.cloud_cover[idx];
}

function cloudText(cloud) {
  if (cloud === null || cloud === undefined) return "구름정보 없음";
  if (cloud <= 30) return `구름 ${cloud}% / 관측 좋음`;
  if (cloud <= 60) return `구름 ${cloud}% / 관측 보통`;
  return `구름 ${cloud}% / 관측 어려움`;
}

function gradeText(item, cloud) {
  const brightness = Number(item.brightness);
  const elevation = Number(item.maxElev);

  if (brightness <= 2.0 && elevation >= 60 && cloud !== null && cloud <= 30) {
    return "⭐⭐⭐ 강력 추천";
  }

  if (brightness <= 2.5 && elevation >= 50 && (cloud === null || cloud <= 60)) {
    return "⭐⭐ 추천";
  }

  return "";
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }
}

async function sendToGoogleSheet(items) {

  const url = process.env.GOOGLE_SCRIPT_URL;
  if (!url) return;

  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      items: items
    })
  });
}

async function main() {
  let sheetItems = [];
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error("TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID가 없습니다.");
  }

  const sats = await fetch(TLE_URL).then((r) => r.json());

  let message = "🛰️ 스타링크 관측 추천\n\n";
  let foundAny = false;
  let strongRecommend = false;

  for (const loc of LOCATIONS) {
    let results = [];

    for (const satRaw of sats.slice(0, 300)) {
      const sat = {
        name: satRaw.OBJECT_NAME,
        title: satRaw.OBJECT_NAME,
        omm: satRaw,
        stdMag: 5,
        launchDate: satRaw.LAUNCH_DATE || "",
      };

      try {
        const r = predict.getVisibleTimes(sat, loc.lat, loc.lon, {
          daysCount: 2,
          timeOfDay: "evening",
          startDaysOffset: 0,
        });

        if (r.timings && r.timings.length > 0) {
          results.push(...r.timings);
        }
      } catch (e) {}
    }

    results = results
      .filter((x) => Number(x.brightness) <= MAX_BRIGHTNESS)
      .filter((x) => Number(x.maxElev) >= MIN_ELEVATION)
      .sort((a, b) => Number(a.brightness) - Number(b.brightness));

    const picked = [];

    for (const item of results) {
      const isDuplicateTime = picked.some((p) => {
        const diffMin = Math.abs(p.start.epoch - item.start.epoch) / 60;
        return diffMin <= DUPLICATE_TIME_MINUTES;
      });

      if (!isDuplicateTime) {
        picked.push(item);
      }

      if (picked.length >= MAX_RESULTS_PER_CITY) break;
    }

    message += `📍${loc.name}\n`;

    if (picked.length === 0) {
      message += "추천 관측 시간이 없습니다.\n\n";
      continue;
    }

    foundAny = true;

    const medals = ["🥇", "🥈", "🥉"];

    for (let i = 0; i < picked.length; i++) {
      const item = picked[i];
      const cloud = await getCloudCover(loc.lat, loc.lon, item.start.epoch);
      const grade = gradeText(item, cloud);

      if (grade.includes("강력 추천")) {
        strongRecommend = true;
      }

      if (grade) {
        message += `${grade}\n`;
      }

      message += `${medals[i]} ${formatKoreanTime(item.start.epoch)} ~ ${formatKoreanTime(
        item.end.epoch
      )}\n`;
      message += `약 ${item.mins}분 / ${dirKo(item.startDirText)}→${dirKo(
        item.endDirText
      )}\n`;
      message += `최대고도 ${Math.round(item.maxElev)}° / 밝기 ${item.brightness}\n`;
      message += `${cloudText(cloud)}\n\n`;
      sheetItems.push({
  city: loc.name,
  time:
    formatKoreanTime(item.start.epoch) +
    " ~ " +
    formatKoreanTime(item.end.epoch),
  direction:
    dirKo(item.startDirText) +
    "→" +
    dirKo(item.endDirText),
  elevation: Math.round(item.maxElev) + "°",
  brightness: String(item.brightness),
  cloud: cloudText(cloud),
  grade: grade || "관측 가능"
});
    }
  }

  message =
    (strongRecommend ? "🟢 오늘 관측 추천\n\n" : "🟡 조건 맞으면 관측 가능\n\n") +
    message;

  message +=
    "※ 실제 관측은 날씨·구름·위성궤도 변경에 따라 달라질 수 있고, 시간은 ±10분 정도 여유를 두세요.";

  if (foundAny) {
  await sendToGoogleSheet(sheetItems);
  await sendTelegram(message);
}
  } else {
    console.log("추천 관측 시간이 없어 전송하지 않음");
  }
}

main().catch(async (err) => {
  console.error(err);
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    await sendTelegram("⚠️ 스타링크 알림 오류\n" + err.message);
  }
});
