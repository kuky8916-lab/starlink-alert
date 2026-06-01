const predict = require("sat-timings");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const LOCATIONS = [
  { name: "대전", lat: 36.3504, lon: 127.3845 },
  { name: "용인", lat: 37.2411, lon: 127.1776 },
];

const TLE_URL =
  "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=json";

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

async function main() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error("TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID가 없습니다.");
  }

  const sats = await fetch(TLE_URL).then((r) => r.json());

  let message = "🛰️ 스타링크 관측 가능 시간\n\n";
  let foundAny = false;

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
      .filter((x) => Number(x.brightness) <= 2.5)
      .sort((a, b) => a.start.epoch - b.start.epoch)
      .slice(0, 5);

    message += `📍${loc.name}\n`;

    if (results.length === 0) {
      message += "관측 가능성이 높은 시간이 없습니다.\n\n";
      continue;
    }

    foundAny = true;

    for (const x of results) {
      message += `- ${formatKoreanTime(x.start.epoch)} ~ ${formatKoreanTime(
        x.end.epoch
      )}\n`;
      message += `  약 ${x.mins}분 / ${dirKo(x.startDirText)}→${dirKo(
        x.endDirText
      )} / 최대고도 ${Math.round(x.maxElev)}° / 밝기 ${x.brightness ?? "-"}\n`;
    }

    message += "\n";
  }

  message += "※ 실제 관측은 날씨·구름·위성궤도 변경에 따라 달라질 수 있고, 시간은 ±10분 정도 여유를 두세요.";

  if (foundAny) {
    await sendTelegram(message);
  } else {
    console.log("오늘/내일 관측 가능성이 높은 시간이 없어 전송하지 않음");
  }
}

main().catch(async (err) => {
  console.error(err);
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    await sendTelegram("⚠️ 스타링크 알림 오류\n" + err.message);
  }
});
