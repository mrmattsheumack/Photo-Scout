// netlify/functions/weather.js
// Proxies Open-Meteo forecast + marine API calls to avoid browser CORS/network issues.
// Deploy alongside your app — the React app calls /.netlify/functions/weather?type=forecast|marine

exports.handler = async (event) => {
  const type = event.queryStringParameters?.type || "forecast";

  const LAT  = -38.3369;
  const LNG  = 144.9690;

  let url;
  if (type === "marine") {
    url = `https://marine-api.open-meteo.com/v1/marine`
      + `?latitude=${LAT}&longitude=${LNG}`
      + `&current=wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_period`
      + `&daily=wave_height_max,swell_wave_height_max`
      + `&timezone=Australia%2FMelbourne&forecast_days=7`;
  } else {
    url = `https://api.open-meteo.com/v1/forecast`
      + `?latitude=${LAT}&longitude=${LNG}`
      + `&current=temperature_2m,wind_speed_10m,wind_direction_10m,cloud_cover,precipitation,weather_code,apparent_temperature`
      + `&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,cloud_cover,weather_code,precipitation`
      + `&daily=sunrise,sunset,precipitation_sum,weather_code_dominant,temperature_2m_max,temperature_2m_min,wind_speed_10m_max`
      + `&timezone=Australia%2FMelbourne&forecast_days=7`;
  }

  try {
    const res = await fetch(url);
    const body = await res.text();
    return {
      statusCode: res.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300", // cache 5 min
      },
      body,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: true, reason: err.message }),
    };
  }
};
