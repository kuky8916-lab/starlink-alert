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

const MAX_CLOUD = 60;
const MAX_PRECIP_PROB = 50;
const MAX_PRECIP_MM = 0.2;

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

async function getWeather(lat, lon, epochSec) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=cloud_cover,precipitation_probability,precipitation` +
    `&timezone=Asia%2FSeoul&forecast_days=3`;

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
  if (idx === -1) {
    return { cloud: null, precipProb: null, precip: null };
  }

  return {
    cloud: data.hourly.cloud_cover[idx],
    precipProb: data.hourly.precipitation_probability[idx],
    precip: data.hourly.precipitation[idx],
  };
}

function isWeatherBad(w) {
  if (w.precipProb !== null && w.precipProb >= MAX_PRECIP_PROB) return true;
  if (w.precip !== null && w.precip >= MAX_PRECIP_MM) return true;
  if (w.cloud !== null && w.cloud > MAX_CLOUD) return true;
  return false;
}

function weatherText(w) {
  const cloud = w.cloud === null ? "구름정보 없음" : `구름 ${w.cloud}%`;
  const rainProb =
    w.precipProb === null ? "강수확률 정보없음" : `강수확률 ${w.precipProb}%`;
  const rain = w.precip === null ? "" : ` / 강수량 ${w.precip}mm`;

  if (isWeatherBad(w)) {
    return `${cloud} / ${rainProb}${rain} / 관측 비추천`;
  }

  if (w.cloud !== null && w.cloud <= 30 && w.precipProb !== null && w.precipProb <= 20) {
    return `${cloud} / ${rainProb}${rain} / 관측 좋음`;
  }

  return `${cloud} / ${rainProb}${rain} / 관측 보통`;
}

function gradeText(item, w) {
  const brightness = Number(item.brightness);
  const elevation = Number(item.maxElev);

  if (isWeatherBad(w)) return "";

  if (
    brightness <= 2.0 &&
    elevation >= 60 &&
    w.cloud !== null &&
    w.cloud <= 30 &&
    w.precipProb !== null &&
    w.precipProb <= 20
  ) {
    return "⭐⭐⭐ 강력 추천";
  }

  if (
    brightness <= 2.5 &&
    elevation >= 50 &&
    (w.precipProb === null || w.precipProb <= 40)
  ) {
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

  if (!res.ok) throw new Error(await res.text());
}

async function main() {
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
  if (!p.item?.start?.epoch || !item?.start?.epoch) {
    return false;
  }

  const diffMin =
    Math.abs(p.item.start.epoch - item.start.epoch) / 60;

  return diffMin <= DUPLICATE_TIME_MINUTES;
});

      if (isDuplicateTime) continue;

      const weather = await getWeather(loc.lat, loc.lon, item.start.epoch);

      if (isWeatherBad(weather)) continue;

      picked.push({ item, weather });

      if (picked.length >= MAX_RESULTS_PER_CITY) break;
    }

    message += `📍${loc.name}\n`;

    if (picked.length === 0) {
      message += "비·구름·강수확률 조건 때문에 추천 관측 시간이 없습니다.\n\n";
      continue;
    }

    foundAny = true;
    const medals = ["🥇", "🥈", "🥉"];

    for (let i = 0; i < picked.length; i++) {
      const { item, weather } = picked[i];
      const grade = gradeText(item, weather);

      if (grade.includes("강력 추천")) strongRecommend = true;

      if (grade) message += `${grade}\n`;

      message += `${medals[i]} ${formatKoreanTime(item.start.epoch)} ~ ${formatKoreanTime(item.end.epoch)}\n`;
      message += `약 ${item.mins}분 / ${dirKo(item.startDirText)}→${dirKo(item.endDirText)}\n`;
      message += `최대고도 ${Math.round(item.maxElev)}° / 밝기 ${Number(item.brightness).toFixed(2)}\n`;
      message += `${weatherText(weather)}\n\n`;
    }
  }

  message =
    (strongRecommend ? "🟢 오늘 관측 추천\n\n" : "🟡 조건 맞으면 관측 가능\n\n") +
    message;

  message += "※ 비·구름·강수확률 조건을 반영했습니다. 실제 시간은 ±10분 정도 여유를 두세요.";

  if (foundAny) {
    await sendTelegram(message);
  } else {
    await sendTelegram("🔴 오늘 스타링크 관측 비추천\n\n비·구름·강수확률 조건 때문에 추천 관측 시간이 없습니다.");
  }
}

main().catch(async (err) => {
  console.error(err);
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    await sendTelegram("⚠️ 스타링크 알림 오류\n" + err.message);
  }
});
