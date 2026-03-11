// netlify/functions/weather.js
const LAT = -38.3369;
const LNG = 144.9690;

exports.handler = async (event) => {
  const type = event.queryStringParameters?.type || "forecast";
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  try {
    let url;
    if (type === "marine") {
      url = `https://marine-api.open-meteo.com/v1/marine`
        + `?latitude=${LAT}&longitude=${LNG}`
        + `&current=wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period`
        + `&daily=wave_height_max,swell_wave_height_max`
        + `&timezone=Australia%2FMelbourne&forecast_days=7`;
    } else {
      url = `https://api.open-meteo.com/v1/forecast`
        + `?latitude=${LAT}&longitude=${LNG}`
        + `&current=temperature_2m,wind_speed_10m,wind_direction_10m,cloud_cover,precipitation,weather_code,apparent_temperature`
        + `&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,cloud_cover,weather_code,precipitation,visibility`
        + `&daily=sunrise,sunset,precipitation_sum,weather_code,temperature_2m_max,temperature_2m_min,wind_speed_10m_max`
        + `&timezone=Australia%2FMelbourne&forecast_days=7&wind_speed_unit=kmh`;
    }

    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ error: true, reason: `Open-Meteo ${res.status}: ${text.slice(0,200)}` }),
      };
    }
    const data = await res.json();
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ error: true, reason: e.message }),
    };
  }
};
