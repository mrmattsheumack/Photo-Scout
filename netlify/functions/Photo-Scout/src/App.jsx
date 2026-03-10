import { useState, useEffect, useRef, useCallback } from "react";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY;
const GMAPS_KEY    = import.meta.env.VITE_GOOGLE_MAPS_KEY;
const EBIRD_KEY    = import.meta.env.VITE_EBIRD_KEY;
const ANTHROPIC_KEY= import.meta.env.VITE_ANTHROPIC_KEY;
const HOME_LAT     = -38.3369;
const HOME_LNG     = 144.9690;
const MODEL        = "claude-sonnet-4-20250514";
const EBIRD_RADIUS = 40;

const sb = async (path, opts={}) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers:{ apikey:SUPABASE_KEY, Authorization:`Bearer ${SUPABASE_KEY}`,
      "Content-Type":"application/json","x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true", Prefer:opts.prefer||"return=representation", ...opts.headers },
    ...opts });
  const txt = await res.text(); return txt ? JSON.parse(txt) : [];
};
const dbGet    = (t,q="")  => sb(`${t}?${q}`);
const dbInsert = (t,d)     => sb(t,{method:"POST",body:JSON.stringify(d)});
const dbDelete = (t,id)    => sb(`${t}?id=eq.${id}`,{method:"DELETE",prefer:"return=minimal"});

// ─── MOON ─────────────────────────────────────────────────────────────────────
const getMoonData = (date) => {
  const jd=(()=>{const y=date.getFullYear(),m=date.getMonth()+1,d=date.getDate();const A=Math.floor(y/100),B=2-A+Math.floor(A/4);return Math.floor(365.25*(y+4716))+Math.floor(30.6001*(m+1))+d+B-1524.5;})();
  const p0=((jd-2451550.1)/29.530588853)%1; const p=p0<0?p0+1:p0;
  const illumination=Math.round((1-Math.cos(p*2*Math.PI))/2*100);
  const names=["New Moon","Waxing Crescent","First Quarter","Waxing Gibbous","Full Moon","Waning Gibbous","Last Quarter","Waning Crescent"];
  const icons=["🌑","🌒","🌓","🌔","🌕","🌖","🌗","🌘"];
  const idx=Math.round(p*8)%8;
  const fmt=h=>{const hh=Math.floor(h),mm=Math.round((h-hh)*60);return `${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}`;};
  const riseH=(p*24+6)%24; const setH=(riseH+12.4)%24;
  const mwMonth=date.getMonth()+1;
  const mwSeason=(mwMonth>=2&&mwMonth<=6);
  const mwDark=illumination<30;
  const mwRating=mwSeason&&mwDark?"excellent":mwDark?"good":illumination<60?"fair":"poor";
  return {p,illumination,name:names[idx],icon:icons[idx],rise:fmt(riseH),set:fmt(setH),mwRating,mwSeason,isFullMoon:idx===4,isMajorPhase:idx===0||idx===2||idx===4||idx===6};
};

const getAstroRating=(moon,cloudCover)=>{
  const cloud=cloudCover||100;
  if(cloud>70)return{label:"Clouded Out",color:"#e74c3c",score:0};
  if(moon.illumination>80)return{label:"Moon Too Bright",color:"#e67e22",score:1};
  if(moon.illumination>40)return{label:"Moderate",color:"#f39c12",score:2};
  if(cloud<20&&moon.illumination<20)return{label:"Excellent",color:"#2ecc71",score:5};
  if(cloud<40&&moon.illumination<30)return{label:"Very Good",color:"#55d47a",score:4};
  return{label:"Good",color:"#a8d8a8",score:3};
};

const haversine=(lat1,lng1,lat2,lng2)=>{
  const R=6371,dLat=(lat2-lat1)*Math.PI/180,dLng=(lng2-lng1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
};

const COASTAL_TAGS=["shorebirds","seabirds","landscape","sunrise","sunset","golden-hour","coastal","surf","waders","mangroves"];
const isCoastal=loc=>(loc?.tags||[]).some(t=>COASTAL_TAGS.includes(t));
const WATER_TAGS = ["coastal","surf","seabirds","shorebirds","wetlands","waterbirds","waders","herons","mangroves"];
const isWaterLoc = (loc) => (loc?.tags||[]).some(t=>WATER_TAGS.includes(t));

// Sun direction from vantage point — Peninsula geography
// Bay-facing (Port Phillip): NW-facing shore — sun rises behind at dawn, sets over water at dusk
// Ocean-facing (Bass Strait): S/SW coast — sun rises over water in AM, sets behind at PM
// Western Port (eastern shore): E-facing — front-lit at dawn
const getSunVantage = (loc, hour, sunrise, sunset) => {
  const tags = loc.tags||[];
  if(!tags.some(t=>["coastal","landscape","sunrise","sunset","seabirds","shorebirds"].includes(t))) return null;
  const lat = loc.lat||0; const lng = loc.lng||144.97;
  const name = (loc.name||"").toLowerCase();
  const isBayFacing = lng < 145.08 && lat > -38.44; // Port Phillip side
  const isOceanFacing = lat < -38.44 && lng < 145.05; // Bass Strait south coast
  const isWesternPort = name.includes("somers")||name.includes("balnarring")||name.includes("tooradin")||name.includes("western port")||name.includes("coolart")||name.includes("merricks");
  const isAM = hour < 12; const isPM = hour >= 16;
  if(isWesternPort){
    if(isAM) return "🌅 Sun rises over Western Port — front-lit water at dawn";
    if(isPM) return "☀️ Sun sets to west — back-lit silhouettes possible";
    return null;
  }
  if(isBayFacing){
    if(isAM) return "☀️ Sun rises behind you — front-lit subjects toward bay";
    if(isPM) return "🌅 Sun sets over bay ahead — golden water reflections";
    return null;
  }
  if(isOceanFacing){
    if(isAM) return "🌅 Sun rises over ocean — dramatic front-lit coastal scenes";
    if(isPM) return "☀️ Sun behind — rim-lit cliffs, spray and surf backlit";
    return null;
  }
  return null;
};

// Reflection quality for water locations
const getReflectionQuality = (wind, waveH, cloud, loc, hour) => {
  if(!isWaterLoc(loc)) return null;
  const tags = loc.tags||[];
  const isEnclosed = tags.some(t=>["wetlands","waterbirds","waders","herons","mangroves"].includes(t));
  const w = wind||0; const h = waveH||0;
  if(isEnclosed){
    if(w < 8)  return {label:"Mirror reflections likely", score:3, emoji:"🪞"};
    if(w < 14) return {label:"Soft reflections possible", score:1, emoji:"💧"};
    return {label:"Rippled — reflections unlikely", score:0, emoji:"〰️"};
  }
  // Coastal/bay
  if(w < 8 && h < 0.3)  return {label:"Glassy bay — reflections excellent", score:3, emoji:"🪞"};
  if(w < 12 && h < 0.5) return {label:"Calm bay — textured reflections", score:1, emoji:"💧"};
  if(h > 1.0)            return {label:"Active swell — dramatic surf", score:1, emoji:"🌊"};
  return {label:"Choppy — limited reflections", score:0, emoji:"〰️"};
};

const waterCondition=(waveH,wavePer,windSpd)=>{
  if(!waveH)return{label:"Unknown",color:"#888",desc:"No marine data"};
  const h=parseFloat(waveH),w=parseFloat(windSpd||0);
  if(h<0.3&&w<10)return{label:"Glassy",color:"#4a90d9",desc:"Mirror-flat. Perfect for long exposures & reflections."};
  if(h<0.5&&w<15)return{label:"Calm",color:"#2ecc71",desc:"Gentle ripples. Excellent seascape conditions."};
  if(h<1.0)return{label:"Light Chop",color:"#a8d8a8",desc:"Small waves. Good texture at golden hour."};
  if(h<1.5)return{label:"Moderate",color:"#f39c12",desc:"Moderate swell. Interesting wave action."};
  if(h<2.5)return{label:"Rough",color:"#e67e22",desc:"Heavy swell. Dramatic but watch your gear."};
  return{label:"Very Rough",color:"#e74c3c",desc:"Large swell. Stay well back."};
};

const seasonal=month=>{
  const s={12:"Summer",1:"Summer",2:"Summer",3:"Autumn",4:"Autumn",5:"Autumn",6:"Winter",7:"Winter",8:"Winter",9:"Spring",10:"Spring",11:"Spring"};
  const b={1:"Post-breeding dispersal. Migratory waders peaking at Western Port. Heat thermals excellent for raptors.",2:"Late summer. Shorebird counts high. Raptors soaring in thermals. Best dawn light of summer.",3:"Autumn migration underway. Robins descending. Wedge-tails pairing up. Spectacular afternoon light.",4:"Flame Robins arriving. Gang-gangs moving through. Cooler air, longer golden hours.",5:"Late autumn. Resident species consolidating. Raptors active on clear cold mornings.",6:"Winter. Raptors perching rather than soaring. Orange-bellied Parrots near Werribee.",7:"Mid-winter. Eagles soar on clear cold days. Shorebirds at Western Port. Bare trees = great visibility.",8:"Late winter. Pre-breeding activity building. Wedge-tails beginning courtship displays.",9:"Spring migration starts. Shorebirds arriving. Swift Parrots passing through. Eagles nest-building.",10:"Peak spring. Raptor nests active. Migratory shorebirds in breeding plumage. Fairy-wren displaying.",11:"Chick-rearing. Shorebirds departing. Swift Parrots heading north. Juvenile raptors fledging.",12:"Early summer. Fledglings everywhere. Shorebirds arriving from north. Long golden hours."};
  return{season:s[month],behaviour:b[month]};
};

const wxIcon=c=>{if(c===undefined||c===null)return"—";if(c===0)return"☀️";if(c<=2)return"⛅";if(c<=3)return"☁️";if(c<=49)return"🌫️";if(c<=59)return"🌦️";if(c<=67)return"🌧️";if(c<=77)return"❄️";if(c<=82)return"🌧️";if(c<=99)return"⛈️";return"🌤️";};
const windDirStr=deg=>{if(deg===undefined)return"—";return["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(deg/22.5)%16];};

const addMins=(timeStr,mins)=>{
  if(!timeStr)return"—";
  const[h,m]=timeStr.split(":").map(Number);
  const total=h*60+m+mins;
  const hh=Math.floor(((total%1440)+1440)%1440/60);
  const mm=((total%60)+60)%60;
  return`${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}`;
};

const getTimeWindows=(sunrise,sunset)=>{
  const parseT=str=>{if(!str)return 6;const[h,m]=(str||"06:00").split(":");return parseInt(h)+parseInt(m)/60;};
  const sr=parseT(sunrise),ss=parseT(sunset);
  return{now:new Date().getHours(),sunrise:Math.round(sr),sunset:Math.round(ss),night:Math.round(ss)+2};
};

// ─── SEASONAL SPECIES INTELLIGENCE ──────────────────────────────────────────
// Per-tag, per-month: { bonus, behaviour, note }
// Month 1=Jan…12=Dec. Southern hemisphere seasons.
const SEASONAL_INTEL = {
  raptors: {
    1:{bonus:2,note:"Thermals excellent. Wedge-tails attending nests. Juveniles dispersing."},
    2:{bonus:2,note:"Peak thermal soaring. Both adults and large juveniles in air."},
    3:{bonus:2,note:"Pair-bonding displays. Wedge-tails and Black-shouldered Kites active."},
    4:{bonus:2,note:"Courtship soaring. Pre-breeding peak activity. Best plumage."},
    5:{bonus:1,note:"Nest-building begins. Perching more than soaring in cold mornings."},
    6:{bonus:1,note:"Incubating — perch photography. Less aerial. Check known nest trees."},
    7:{bonus:1,note:"Eggs/early chicks. Adults hunting hard. Cold thermals mid-day."},
    8:{bonus:2,note:"Chicks growing. Adults very active hunting. Pre-fledge excitement."},
    9:{bonus:3,note:"🐣 Fledgling season. Juvenile Wedge-tails, Peregrines learning to fly. Prime."},
    10:{bonus:3,note:"🐣 Fledglings + juveniles. Family groups. Best of year for raptors."},
    11:{bonus:2,note:"Post-fledge dispersal. Juveniles exploring. Still excellent."},
    12:{bonus:2,note:"Juveniles maturing. Breeding pairs re-establishing territories."},
  },
  eagles: {
    1:{bonus:2,note:"Wedge-tails soaring on summer thermals — peak thermal hours 10am–3pm."},
    2:{bonus:2,note:"Late summer thermals. Often multiple birds in one thermal."},
    3:{bonus:3,note:"💛 Courtship displays beginning. Undulating flight, talon-grappling."},
    4:{bonus:3,note:"💛 Active courtship and nest preparation. Best aerial displays."},
    5:{bonus:2,note:"Nest-building. Pair often perched together near nest."},
    6:{bonus:1,note:"Incubating. One adult on nest, other perching nearby."},
    7:{bonus:1,note:"Brooding. Less visible but adults hunting on clear cold days."},
    8:{bonus:2,note:"Chicks visible in nest. Adults making frequent prey deliveries."},
    9:{bonus:3,note:"🐣 Chicks near fledging. Very active around nest site."},
    10:{bonus:3,note:"🐣 Newly fledged juveniles — distinctive brown plumage, clumsy flight."},
    11:{bonus:2,note:"Juveniles dispersing from natal territory. Good chance of sightings."},
    12:{bonus:2,note:"Young birds settling. Adults beginning next breeding cycle."},
  },
  shorebirds: {
    1:{bonus:3,note:"Peak migratory wader numbers. Red-necked Stints, Sharp-tailed Sandpipers."},
    2:{bonus:3,note:"Waders still present in good numbers before northward migration."},
    3:{bonus:2,note:"Wader numbers declining as birds begin northward migration."},
    4:{bonus:1,note:"Resident species only. Good for Pied Oystercatcher, Red-capped Plover."},
    5:{bonus:1,note:"Quiet for waders. Resident species — Oystercatchers, Masked Lapwing."},
    6:{bonus:1,note:"Quiet period. Resident waders in breeding territories."},
    7:{bonus:1,note:"Some early arrivals from north. Resident species breeding."},
    8:{bonus:1,note:"Early migratory arrivals starting. Stints in small numbers."},
    9:{bonus:2,note:"Migratory waders arriving. Mix of species building."},
    10:{bonus:3,note:"🥚 Hooded Plover nesting on beaches. Wader numbers building strongly."},
    11:{bonus:3,note:"🐣 Hooded Plover chicks. Peak migratory diversity before summer."},
    12:{bonus:3,note:"Migratory waders at maximum. Red-necked Stints, Curlew Sandpipers."},
  },
  "small-birds": {
    1:{bonus:1,note:"Resident small birds quiet. Early morning activity best."},
    2:{bonus:1,note:"Post-breeding. Families in dense cover. Dawn chorus best window."},
    3:{bonus:2,note:"Robins arriving in lowland areas. Flame and Scarlet Robins."},
    4:{bonus:3,note:"💛 Flame Robins in striking breeding plumage arriving on Peninsula."},
    5:{bonus:3,note:"💛 Robins and other winter visitors at their best. Thornbills flocking."},
    6:{bonus:2,note:"Winter residents settled. Flocks of thornbills and pardalotes."},
    7:{bonus:2,note:"Mid-winter. Robins, thornbills, treecreepers active in still mornings."},
    8:{bonus:2,note:"Pre-breeding activity. Song increasing. Wrens developing breeding plumage."},
    9:{bonus:3,note:"🥚 Fairy-wrens breeding. Males in full blue plumage. Superb Fairy-wren nesting."},
    10:{bonus:3,note:"🐣 Fairy-wren chicks, pardalote nesting, honeyeater breeding. Peak diversity."},
    11:{bonus:2,note:"🐣 Fledgling small birds everywhere. Families feeding in open."},
    12:{bonus:1,note:"Post-breeding dispersal. Juvenile plumage birds learning."},
  },
  parrots: {
    1:{bonus:1,note:"Lorikeets nesting in hollows. Rosellas in family groups."},
    2:{bonus:1,note:"Post-breeding. Flocks forming. Good for Rainbow Lorikeet flocks at dawn."},
    3:{bonus:2,note:"Gang-gang Cockatoos moving through. Yellow-tailed Black Cockatoos in she-oaks."},
    4:{bonus:3,note:"💛 Gang-gang Cockatoos — males with red crests very active. YTBC feeding."},
    5:{bonus:3,note:"💛 Yellow-tailed Black Cockatoos in peak feeding on banksias and she-oaks."},
    6:{bonus:2,note:"YTBC and Gang-gang present. Cold mornings bring parrots to lower areas."},
    7:{bonus:2,note:"Cockatoos active mid-morning once warmed. Crimson Rosellas conspicuous."},
    8:{bonus:2,note:"Pre-breeding displays starting. Swift Parrots passing through."},
    9:{bonus:3,note:"🥚 Swift Parrots migrating through. Breeding season beginning for residents."},
    10:{bonus:2,note:"Lorikeets and rosellas nesting. Swift Parrots still possible."},
    11:{bonus:2,note:"🐣 Fledgling parrots — family groups very photogenic."},
    12:{bonus:1,note:"Residents nesting. Lorikeet flocks feeding in flowering eucalypts."},
  },
  waterbirds: {
    1:{bonus:2,note:"Herons and egrets breeding in colonies. Cormorants wing-drying."},
    2:{bonus:2,note:"Waterbird breeding peak. Royal Spoonbill and Straw-necked Ibis active."},
    3:{bonus:2,note:"Post-breeding dispersal. Good variety at wetlands."},
    4:{bonus:2,note:"Winter visitors arriving. Hardheads and other ducks building."},
    5:{bonus:3,note:"Winter waterbird diversity peaks. Grebes in breeding plumage."},
    6:{bonus:3,note:"💛 Australasian Grebe in breeding plumage — rich chestnut neck."},
    7:{bonus:2,note:"Waterbirds settled at wetlands. Good for long morning sessions."},
    8:{bonus:2,note:"Pre-breeding activity. Egrets developing breeding plumes."},
    9:{bonus:3,note:"🥚 Herons and cormorants nesting. Egrets in breeding plumage."},
    10:{bonus:3,note:"🐣 Waterbird chick season. Grebes carrying young on backs."},
    11:{bonus:2,note:"🐣 Fledgling waterbirds. Ducklings and coot chicks everywhere."},
    12:{bonus:2,note:"Breeding continues. Waterbird numbers at seasonal high."},
  },
  waders: {
    1:{bonus:3,note:"Peak wader diversity. Stints, sandpipers, godwits at roost."},
    2:{bonus:3,note:"Waders still present. Some acquiring breeding plumage before leaving."},
    3:{bonus:2,note:"Numbers declining. Good time before they depart."},
    4:{bonus:1,note:"Resident waders only after migratory departure."},
    5:{bonus:1,note:"Quiet. Resident species — oystercatchers and lapwings."},
    6:{bonus:1,note:"Resident species holding territories."},
    7:{bonus:1,note:"Quiet. Early scouts possible by late July."},
    8:{bonus:2,note:"First migratory arrivals. Sharp-tailed Sandpipers often first back."},
    9:{bonus:3,note:"Wader migration building. Mix of species, some in breeding plumage."},
    10:{bonus:3,note:"🥚 Hooded Plover nesting. Wader diversity building strongly."},
    11:{bonus:3,note:"Peak pre-summer wader numbers. Species diversity at its best."},
    12:{bonus:3,note:"Peak migratory wader season begins. Red-necked Stints abundant."},
  },
  wetlands: {
    1:{bonus:2,note:"Water levels variable. Waterbirds concentrated around remaining water."},
    2:{bonus:2,note:"Late summer — some wetlands drying, concentrating birds."},
    3:{bonus:2,note:"Autumn rains refilling wetlands. Waterbirds returning."},
    4:{bonus:3,note:"Wetlands filling after autumn rains. Waterbird variety improving."},
    5:{bonus:3,note:"Good water levels. Winter waterbirds settled and active."},
    6:{bonus:3,note:"Peak wetland conditions. Full water levels, diverse waterbird community."},
    7:{bonus:3,note:"Wetlands at capacity. Best conditions for waterbird photography."},
    8:{bonus:2,note:"Pre-breeding activity. Wetlands still holding well."},
    9:{bonus:2,note:"Spring wetlands. Breeding activity beginning."},
    10:{bonus:2,note:"🥚 Breeding waterbirds. Wetland birds at their most active."},
    11:{bonus:2,note:"🐣 Chick season. Wetlands busy with young birds."},
    12:{bonus:2,note:"Post-breeding. Summer drying may concentrate birds."},
  },
  forest: {
    1:{bonus:1,note:"Quiet in heat. Dawn only for productivity."},
    2:{bonus:1,note:"Late summer. Early morning for small birds before heat."},
    3:{bonus:2,note:"Autumn migration through forest understorey. Robins appearing."},
    4:{bonus:3,note:"Winter robins and migrants in forest. Excellent variety."},
    5:{bonus:3,note:"Peak winter forest birds. Gang-gangs, robins, wrens."},
    6:{bonus:2,note:"Quiet but Gang-gangs and YTBC in canopy."},
    7:{bonus:2,note:"Cold clear mornings produce good forest activity."},
    8:{bonus:2,note:"Pre-spring activity increasing. Song building."},
    9:{bonus:3,note:"🥚 Spring migrants. Wrens and pardalotes beginning to nest."},
    10:{bonus:3,note:"🐣 Forest bird breeding peak. Incredibly active at dawn."},
    11:{bonus:2,note:"🐣 Fledgling season. Noisy families in canopy."},
    12:{bonus:1,note:"Post-breeding. Dawn still productive in heat."},
  },
};

// ─── LOCATION RATER ───────────────────────────────────────────────────────────
const rateLocation = (loc, hour, mode, wx, marine, sightings=[], month=new Date().getMonth()+1) => {
  const tags = loc?.tags || [];

  // ── Hourly data lookup ─────────────────────────────────────────────────────
  const getHourlyIdx = () => {
    if(!wx?.hourly?.time?.length) return 0;
    const todayStr = new Date().toISOString().slice(0,10);
    // Exact: today + target hour
    const target = `${todayStr}T${String(hour).padStart(2,"0")}:00`;
    const exact = wx.hourly.time.indexOf(target);
    if(exact >= 0) return exact;
    // Fallback: any entry today with matching hour
    for(let i=0;i<wx.hourly.time.length;i++){
      const t = wx.hourly.time[i]||"";
      if(t.startsWith(todayStr) && parseInt(t.split("T")[1]?.split(":")[0]??"99") === hour) return i;
    }
    // Last resort: current hour
    const nowH = new Date().getHours();
    const fi = wx.hourly.time.findIndex(t=>parseInt((t||"").split("T")[1]?.split(":")[0]??"99")===nowH);
    return fi >= 0 ? fi : 0;
  };
  const idx = getHourlyIdx();
  const hGet = (arr) => arr && idx < arr.length && arr[idx] != null ? arr[idx] : null;

  // Pull conditions — hourly → current → null (never fake data when wx missing)
  const wxAvail = wx != null;
  const wind    = wxAvail ? (hGet(wx?.hourly?.wind_speed_10m)    ?? wx?.current?.wind_speed_10m    ?? null) : null;
  const cloud   = wxAvail ? (hGet(wx?.hourly?.cloud_cover)        ?? wx?.current?.cloud_cover       ?? null) : null;
  const temp    = wxAvail ? (hGet(wx?.hourly?.temperature_2m)     ?? wx?.current?.temperature_2m    ?? null) : null;
  const wxCode  = wxAvail ? (hGet(wx?.hourly?.weather_code)       ?? wx?.current?.weather_code      ?? 0)   : 0;
  const windDir = wxAvail ? (hGet(wx?.hourly?.wind_direction_10m) ?? wx?.current?.wind_direction_10m ?? null): null;
  const rain    = wxAvail ? (wx?.current?.precipitation ?? 0) : 0;
  const waveH   = marine?.current?.wave_height ?? 0;
  // Don't score on weather if we don't have data
  if(!wxAvail) {
    // Sightings-only scoring still runs below; skip weather gates
  }

  if(wxAvail && (rain > 3 || wxCode >= 63)) return {rating:"red", summary:`⛈️ Heavy rain — not recommended`, score:-5, temp, wind, cloud, reasons:[],seasonNote:"",wxNotes:[],reflNote:null};

  let score = 0;
  let reasons = [];
  let seasonNote = "";

  if(mode === "wildlife") {
    // ── Time-of-day bonuses (balanced, no single dominant category) ──────────
    const isDawn   = hour >= 5  && hour <= 8;
    const isMorn   = hour >= 8  && hour <= 11;
    const isMidDay = hour >= 11 && hour <= 14;
    const isAftn   = hour >= 14 && hour <= 18;
    const isDusk   = hour >= 17 && hour <= 20;

    // Raptors — thermals mid-morning to afternoon, dawn for perch shots
    if(tags.some(t=>["raptors","eagles"].includes(t))){
      if(isMidDay || isAftn) { score += 1; reasons.push("Thermal window"); }
      if(isDawn)             { score += 1; reasons.push("Dawn perch activity"); }
    }
    // Shorebirds/waders — best at low light, avoid harsh midday
    if(tags.some(t=>["shorebirds","waders"].includes(t))){
      if(isDawn || isDusk)   { score += 2; reasons.push("Wader low-light window"); }
      else if(isMorn)        { score += 1; reasons.push("Morning wader activity"); }
    }
    // Small birds, parrots, forest — dawn chorus is king
    if(tags.some(t=>["small-birds","parrots","forest"].includes(t))){
      if(isDawn)             { score += 2; reasons.push("Dawn chorus"); }
      else if(isMorn)        { score += 1; reasons.push("Morning activity"); }
      if(isDusk)             { score += 1; reasons.push("Evening roost"); }
    }
    // Waterbirds / wetlands — morning light on water
    if(tags.some(t=>["waterbirds","wetlands","herons"].includes(t))){
      if(isDawn || isMorn)   { score += 2; reasons.push("Morning waterbird light"); }
    }
    // Seabirds
    if(tags.some(t=>["seabirds"].includes(t))){
      if(isDawn || isDusk)   { score += 1; reasons.push("Seabird low-light"); }
    }
    // Water reflection bonus for wildlife (waders/shorebirds/waterbirds in calm)
    if(isWaterLoc(loc)){
      const refl = getReflectionQuality(wind, waveH, cloud, loc, hour);
      if(refl && refl.score >= 3){ score += 2; reasons.push("Calm water — reflection shots of waders"); }
      else if(refl && refl.score >= 1){ score += 1; reasons.push("Moderate reflections possible"); }
    }

    // ── Seasonal intelligence ────────────────────────────────────────────────
    let maxSeasonBonus = 0;
    for(const tag of tags){
      const intel = SEASONAL_INTEL[tag]?.[month];
      if(intel && intel.bonus > maxSeasonBonus){
        maxSeasonBonus = intel.bonus;
        seasonNote = intel.note;
      }
    }
    score += maxSeasonBonus;
    if(seasonNote) reasons.push(seasonNote.replace(/^[🥚🐣💛🌿]\s*/,"").split(".")[0]);

    // ── Sightings intelligence ───────────────────────────────────────────────
    if(sightings.length > 0){
      const locName = (loc.name||"").toLowerCase();
      // Count sightings at this location in same month ±1
      const locSightings = sightings.filter(s => {
        const lMatch = (s.location_name||"").toLowerCase().includes(locName.slice(0,7));
        const mDiff  = Math.abs((s.month||0) - month);
        return lMatch && (mDiff <= 1 || mDiff >= 11);
      });
      if(locSightings.length >= 10){ score += 3; reasons.push(`${locSightings.length} of your sightings here this season`); }
      else if(locSightings.length >= 4){ score += 2; reasons.push(`${locSightings.length} sightings this season`); }
      else if(locSightings.length >= 1){ score += 1; reasons.push(`${locSightings.length} sighting${locSightings.length>1?"s":""} this season`); }

      // Time-of-day match bonus
      const todStr = isDawn?"Dawn":isMorn?"Morning":isMidDay?"Midday":isAftn?"Afternoon":"Dusk";
      const timeMatch = locSightings.filter(s=>(s.time_of_day||"")===todStr);
      if(timeMatch.length >= 3){ score += 1; reasons.push(`You often shoot here at ${todStr}`); }
    }

    // ── Weather conditions ───────────────────────────────────────────────────
    if(wxAvail && wind != null){
      if(wind < 12)      { score += 1; }
      else if(wind > 25) { score -= 1; reasons.push(`${Math.round(wind)}km/h wind`); }
    }
    if(wxAvail && cloud != null && cloud < 25) { score += 1; reasons.push("Clear skies"); }
    if(wxAvail && wxCode >= 50 && wxCode < 63) { score -= 1; reasons.push("Light rain"); }
    // ── Wind shelter scoring ─────────────────────────────────────────────────
    // When windy, sheltered locations rank higher; exposed locations rank lower
    if(wxAvail && wind != null && wind > 20){
      const isSheltered = tags.some(t=>["forest","small-birds","parrots","wetlands","waterbirds"].includes(t));
      const isExposed   = tags.some(t=>["coastal","surf","landscape","thermal"].includes(t)) && !isSheltered;
      if(isSheltered)  { score += 2; reasons.push(`${Math.round(wind)}km/h wind — sheltered habitat favoured`); }
      else if(isExposed){ score -= 1; reasons.push(`${Math.round(wind)}km/h wind — exposed, birds sheltering`); }
    } else if(wxAvail && wind != null && wind > 12){
      const isSheltered = tags.some(t=>["forest","small-birds","parrots"].includes(t));
      if(isSheltered) { score += 1; reasons.push("Moderate wind — forest birds more active here"); }
    }

  } else {
    // ── LANDSCAPE mode ────────────────────────────────────────────────────────
    if(tags.some(t=>["sunrise","landscape","coastal"].includes(t)) && hour >= 5 && hour <= 8) { score += 4; reasons.push("Sunrise light"); }
    if(tags.some(t=>["sunset","golden-hour","coastal"].includes(t)) && hour >= 17 && hour <= 20){ score += 4; reasons.push("Golden hour"); }
    if(isCoastal(loc)){
      const wc = waterCondition(waveH, 8, wind);
      if(wc.label==="Glassy"||wc.label==="Calm"){ score += 2; reasons.push(wc.label+" water"); }
      else if(wc.label==="Rough"||wc.label==="Very Rough"){ score += 1; reasons.push(`${wc.label} swell`); }
    }
    // Water reflection bonus (landscape)
    if(isWaterLoc(loc)){
      const refl = getReflectionQuality(wind, waveH, cloud, loc, hour);
      if(refl && refl.score >= 3){ score += 2; reasons.push(refl.emoji+" "+refl.label); }
      else if(refl && refl.score >= 1){ score += 1; reasons.push(refl.emoji+" "+refl.label); }
    }
    if(cloud > 80 && hour > 9 && hour < 16) { score -= 2; reasons.push("Flat overcast"); }
    if(cloud > 15 && cloud < 65)            { score += 1; reasons.push("Textured sky"); }
    if(cloud < 10)                          { score += 1; reasons.push("Clear sky"); }
  }

  const wc = isCoastal(loc) ? waterCondition(waveH, 8, wind) : null;
  const tempStr  = temp != null ? `${Math.round(temp)}°C` : "—";
  const windStr  = `${Math.round(wind)}km/h ${windDirStr(windDir)}`;
  const cloudStr = cloud != null ? `${Math.round(cloud)}%` : "—";
  const waterStr = (wc && wc.label !== "Unknown") ? ` · 🌊 ${wc.label}` : "";
  const summary  = `${wxIcon(wxCode)} ${tempStr} · 💨 ${windStr} · ☁️ ${cloudStr}${waterStr}`;

  // Weather effect notes — only when wx data available
  const wxNotes = [];
  if(wxAvail && wind != null){
    const isSheltered = tags.some(t=>["forest","small-birds","parrots","wetlands","waterbirds"].includes(t));
    const isExposed   = tags.some(t=>["coastal","surf","raptors","eagles","thermal"].includes(t));
    if(wind > 25){
      if(isSheltered) wxNotes.push(`💨 ${Math.round(wind)}km/h — dense vegetation blocks wind, birds active in canopy`);
      else if(isExposed) wxNotes.push(`💨 ${Math.round(wind)}km/h — birds sheltering, raptors may soar on gusts`);
      else wxNotes.push(`💨 Strong wind ${Math.round(wind)}km/h — expect fast, erratic flight paths`);
    } else if(wind > 15){
      if(isSheltered) wxNotes.push(`💨 ${Math.round(wind)}km/h — sheltered here, better than exposed sites today`);
      else wxNotes.push(`💨 ${Math.round(wind)}km/h — moderate wind, birds favour sheltered areas`);
    } else if(wind < 8){
      wxNotes.push(`🍃 Light wind ${Math.round(wind)}km/h — stable flight, ideal for perch and reflection shots`);
    }
  }
  if(wxAvail && temp != null && temp > 32) wxNotes.push("🌡️ Hot — birds in shade, activity drops midday");
  if(wxAvail && temp != null && temp < 10) wxNotes.push("🥶 Cool — raptors roost later, thermals after 9am");
  if(wxAvail && cloud != null && cloud > 80) wxNotes.push("☁️ Overcast — soft even light, good for plumage detail");
  if(wxAvail && cloud != null && cloud < 10 && wind != null && wind < 8) wxNotes.push("☀️ Clear & calm — golden hour colours will be vivid");
  if(wxAvail && wxCode >= 50 && wxCode < 63) wxNotes.push("🌧️ Light rain — birds shelter in dense vegetation");

  // Water/reflection notes
  const reflData = isWaterLoc(loc) ? getReflectionQuality(wind, waveH, cloud, loc, hour) : null;
  const reflNote = reflData ? `${reflData.emoji} ${reflData.label}` : null;

  return {
    rating: score >= 5 ? "green" : score >= 2 ? "amber" : "red",
    summary,
    score,
    temp, wind, cloud, wxCode, windDir,
    reasons,
    seasonNote,
    wxNotes,
    reflNote,
  };
};

// ─── DEFAULT LOCATIONS ────────────────────────────────────────────────────────
const DEFAULT_LOCATIONS = [
  { name:"Arthurs Seat Ridge",              lat:-38.3607, lng:144.9561, type:"both",      tags:["raptors","landscape","thermal","exposed"],              notes:"Prime Wedge-tailed Eagle thermal soaring. Panoramic views over Port Phillip Bay." },
  { name:"Boundary Road, Dromana",          lat:-38.3369, lng:144.9690, type:"wildlife",  tags:["raptors","parrots"],                          notes:"Home base. Regular raptor activity over open paddocks." },
  { name:"Safety Beach Foreshore",          lat:-38.3285, lng:145.0107, type:"both",      tags:["shorebirds","landscape","sunrise","coastal"],  notes:"Excellent sunrise. Waders at low tide. Red-necked Stints Sep–Apr." },
  { name:"Chinaman's Creek, Tootgarook",     lat:-38.2080, lng:144.9020, type:"wildlife",  tags:["shorebirds","waders","herons","wetlands"],                notes:"Wetland habitat near Tootgarook. Herons, egrets, cormorants year-round." },
  { name:"Point Nepean National Park",      lat:-38.5050, lng:144.6900, type:"both",      tags:["seabirds","landscape","migrants","coastal"],   notes:"Migratory seabirds. Hooded Plovers nest. Stunning coastal landscape." },
  { name:"Tuerong",                         lat:-38.3700, lng:145.0200, type:"wildlife",  tags:["raptors","parrots"],                          notes:"Open paddocks and remnant bush. Gang-gang and Wedge-tail regular." },
  { name:"Martha's Cove",                   lat:-38.3100, lng:145.0280, type:"both",      tags:["shorebirds","landscape","golden-hour","coastal"], notes:"Marina with excellent late afternoon light. Terns and cormorants." },
  { name:"Balnarring Beach",                lat:-38.4200, lng:145.1000, type:"both",      tags:["shorebirds","landscape","sunset","coastal"],   notes:"Quiet beach. Red-capped Plovers. Superb sunset seascapes." },
  { name:"Western Port Bay – Tooradin",     lat:-38.2170, lng:145.3840, type:"wildlife",  tags:["shorebirds","waders","mangroves"],             notes:"Internationally significant shorebird site. Vast mudflats at low tide." },
  { name:"Greens Bush, Mornington NP",      lat:-38.4900, lng:144.8600, type:"wildlife",  tags:["small-birds","parrots","forest","sheltered"],              notes:"Dense bushland. Scarlet and Flame Robin in winter. Gang-gang Cockatoo." },
  { name:"Cape Schanck Lighthouse",         lat:-38.5200, lng:144.8800, type:"both",      tags:["seabirds","landscape","sunset","coastal","surf"], notes:"Dramatic coastal scenery. Albatross offshore. Iconic landscape." },
  { name:"Devilbend Reservoir",             lat:-38.3450, lng:145.1050, type:"wildlife",  tags:["raptors","waterbirds","eagles"],               notes:"Large reservoir. Regular Wedge-tailed Eagle and Osprey." },
  { name:"Moorooduc Quarry",                lat:-38.2350, lng:145.1000, type:"wildlife",  tags:["raptors","small-birds"],                      notes:"Peregrine Falcon nesting site. Excellent vantage points." },
  { name:"Flinders Blowhole",               lat:-38.4780, lng:145.0880, type:"both",      tags:["landscape","seabirds","sunrise","coastal","surf"], notes:"Rocky coastline. Superb sunrise. Shearwaters offshore." },
  { name:"Rye Back Beach",                  lat:-38.3720, lng:144.8200, type:"both",      tags:["landscape","shorebirds","surf","coastal"],     notes:"Ocean beach, surf patterns. Hooded Plovers. Moody seascape." },
  { name:"Bruce Road Paddocks, Tuerong",    lat:-38.3850, lng:145.0350, type:"wildlife",  tags:["raptors","eagles"],                           notes:"Open farmland. Consistent Wedge-tailed Eagle activity. Good thermals." },
  { name:"Mt Eliza Cliffs",                 lat:-38.1800, lng:145.0700, type:"both",      tags:["seabirds","landscape","sunrise","coastal"],    notes:"Elevated coastal cliffs. Port Phillip Bay views. Peregrine Falcon territory." },
  { name:"Rosebud Foreshore",               lat:-38.3600, lng:144.9000, type:"both",      tags:["shorebirds","landscape","sunset","coastal"],   notes:"Long sandy beach. Pied Oystercatcher. Good sunset over bay." },
  { name:"Somers Beach",                    lat:-38.4100, lng:145.1500, type:"both",      tags:["shorebirds","landscape","coastal"],            notes:"Sheltered Western Port beach. Fairy Tern roost. Good wader habitat." },
  { name:"Merricks Beach",                  lat:-38.3900, lng:145.0800, type:"both",      tags:["landscape","coastal","sunset"],                notes:"Small sheltered cove. Beautiful light. Red-necked Stint in season." },
  { name:"Ashcombe Maze & Lavender Gardens",lat:-38.3500, lng:145.1200, type:"wildlife",  tags:["small-birds","parrots"],                           notes:"Garden habitat. Good for thornbills, honeyeaters, rosellas." },
  { name:"Coolart Wetlands",                lat:-38.3800, lng:145.1600, type:"wildlife",  tags:["shorebirds","waders","waterbirds","herons"],        notes:"Trust for Nature reserve. Excellent wetland for herons, ibis, spoonbills." },
  { name:"Tootgarook Wetlands",             lat:-38.1961, lng:144.8917, type:"wildlife",  tags:["wetlands","waterbirds","waders","shorebirds"],      notes:"Seasonal wetlands near Tootgarook. Good for waders and waterbirds." },
  { name:"Hillview Reserve",                lat:-38.2889, lng:145.0372, type:"wildlife",  tags:["small-birds","parrots","forest"],                   notes:"Bushland reserve. Regular fairy-wren, pardalote and honeyeater activity." },
  { name:"Seawinds Gardens",                lat:-38.3769, lng:145.0019, type:"both",      tags:["small-birds","parrots","garden","landscape"],       notes:"Arthurs Seat State Park gardens. Diverse small birds and rosellas." },
  { name:"Edithvale Wetlands",              lat:-38.0167, lng:145.1000, type:"wildlife",  tags:["wetlands","waterbirds","waders","shorebirds"],      notes:"Edithvale-Seaford Wetlands. Significant migratory shorebird site." },
  { name:"Port Phillip Bay",                lat:-38.1500, lng:144.9000, type:"both",      tags:["coastal","seabirds","landscape","shorebirds"],      notes:"Bay coastline. Good for coastal and seabird photography." },
];
const XMP_SIGHTINGS = [{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC09493"},{"species":"Brown Thornbill","location_name":"","date":"2024-01-14","month":1,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 _DSC7613"},{"species":"Eastern Rosella","location_name":"Hillview Reserve","date":"2026-01-27","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC04735"},{"species":"White-naped Honeyeater","location_name":"","date":"2026-02-15","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 DSC06911"},{"species":"Eastern Rosella","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC01280"},{"species":"Black Swan","location_name":"","date":"2023-12-07","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 493mm eq \u00b7 1/800s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 _DSC0365"},{"species":"Hooded Plover","location_name":"","date":"2024-01-02","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/2500s \u00b7 f/7.1 \u00b7 ISO640 \u00b7 \u26052 \u00b7 _DSC2665"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC09552"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-03","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/2000s \u00b7 f/6.3 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC9179"},{"species":"Nankeen Kestrel","location_name":"Tootgarook Wetlands","date":"2025-08-18","month":8,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO800 \u00b7 \u26052 \u00b7 _DSC4660"},{"species":"Hooded Plover","location_name":"","date":"2024-01-04","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/3200s \u00b7 f/6.3 \u00b7 ISO640 \u00b7 \u26052 \u00b7 _DSC4033"},{"species":"Brown Thornbill","location_name":"Tootgarook Wetlands","date":"2024-02-16","month":2,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/2000s \u00b7 f/9.0 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC6030"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2025-12-13","month":12,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 _DSC1103"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO5000 \u00b7 \u26052 \u00b7 DSC00099"},{"species":"Brown Thornbill","location_name":"","date":"2024-04-21","month":4,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1000s \u00b7 f/6.3 \u00b7 ISO800 \u00b7 \u26052 \u00b7 _DSC9310"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-27","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC05069"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 _DSC0160"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-01","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 275mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC09521"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC09705"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC09564"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC09502"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-03","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/2000s \u00b7 f/6.3 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 _DSC9078"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 _DSC4701"},{"species":"Eastern Grey Kangaroo","location_name":"","date":"2023-09-27","month":9,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/1250s \u00b7 f/7.1 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 _DSC5364"},{"species":"Black-shouldered Kite","location_name":"","date":"2021-12-03","month":12,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO640 \u00b7 \u26052 \u00b7 _DSC5406"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-27","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/2500s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC04840"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC09377"},{"species":"Sulphur-crested Cockatoo","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 375mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC04282"},{"species":"Eastern Yellow Robin","location_name":"","date":"2025-08-07","month":8,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/7.1 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 _DSC3270"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC00772"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/7.1 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC3589"},{"species":"Great Egret","location_name":"","date":"2024-05-01","month":5,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 639mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC2278"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC03373-2"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC7039"},{"species":"Brown Goshawk","location_name":"","date":"2024-01-14","month":1,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/160s \u00b7 f/6.3 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 _DSC6704"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 437mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 _DSC7834"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-26","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/3200s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC04447"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 586mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 _DSC8137"},{"species":"Eastern Rosella","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC09668"},{"species":"Brown Thornbill","location_name":"Tootgarook Wetlands","date":"2024-02-22","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/2000s \u00b7 f/6.3 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 _DSC6993"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-07","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 DSC02281"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26054 \u00b7 DSC03408-2"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1600s \u00b7 f/7.1 \u00b7 ISO400 \u00b7 \u26052 \u00b7 _DSC7852"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC09684"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-03","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/7.1 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC9317"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO5000 \u00b7 \u26052 \u00b7 _DSC8334"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 564mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC0091-2"},{"species":"Black-shouldered Kite","location_name":"","date":"2023-11-24","month":11,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/3200s \u00b7 f/5.6 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC9702"},{"species":"Sulphur-crested Cockatoo","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 375mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC04281"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-01","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 275mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC09532"},{"species":"Black-shouldered Kite","location_name":"","date":"2021-12-04","month":12,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/5000s \u00b7 f/6.3 \u00b7 ISO800 \u00b7 \u26052 \u00b7 _DSC5795"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC00360"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-29","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 678mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC07713"},{"species":"Crimson Rosella","location_name":"","date":"2025-11-23","month":11,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/5000s \u00b7 f/6.3 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 _DSC5211"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-01","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 DSC09313"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC03455"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC05190"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 649mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC8112"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC09731"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 _DSC4717"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 543mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC3847"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC04649"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-14","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC06034"},{"species":"White-bellied Sea Eagle","location_name":"","date":"2024-01-07","month":1,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/3200s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 _DSC5288"},{"species":"Eastern Rosella","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC01279"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-29","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC07932"},{"species":"Black-shouldered Kite","location_name":"Tootgarook Wetlands","date":"2024-02-15","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC4270"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO400 \u00b7 \u26052 \u00b7 DSC03760"},{"species":"Sulphur-crested Cockatoo","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 375mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC04280"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-29","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC07894"},{"species":"Yellow-tailed Black Cockatoo","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 400mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC00946"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC7023"},{"species":"Australasian Grebe","location_name":"","date":"2021-12-07","month":12,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/800s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC5960"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-26","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/3200s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26054 \u00b7 DSC04449"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-28","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC06109"},{"species":"Sulphur-crested Cockatoo","location_name":"","date":"2026-02-13","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC05866"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC00287"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC03193-2"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC09416"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 _DSC4699"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC3659"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC03614"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC09491"},{"species":"Black-shouldered Kite","location_name":"Tootgarook Wetlands","date":"2024-02-22","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO10000 \u00b7 \u26052 \u00b7 _DSC8262"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-03","month":12,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC8878"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-01-23","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO500 \u00b7 \u26052 \u00b7 DSC03562"},{"species":"Great Egret","location_name":"Tootgarook Wetlands","date":"2025-08-25","month":8,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 759mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO640 \u00b7 \u26052 \u00b7 _DSC6861"},{"species":"Crimson Rosella","location_name":"","date":"2025-10-17","month":10,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 200mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO10000 \u00b7 \u26052 \u00b7 _DSC2518"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-01-23","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO500 \u00b7 \u26052 \u00b7 DSC03560"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO400 \u00b7 \u26052 \u00b7 DSC03763"},{"species":"Crimson Rosella","location_name":"Hillview Reserve","date":"2026-01-28","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO5000 \u00b7 \u26052 \u00b7 DSC05725"},{"species":"Crimson Rosella","location_name":"","date":"2023-10-06","month":10,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/1250s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC6818"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/7.1 \u00b7 ISO320 \u00b7 \u26052 \u00b7 _DSC7810"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC04569"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-07","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 DSC02394"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 DSC05191"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC09704"},{"species":"Australasian Harrier","location_name":"Tootgarook Wetlands","date":"2025-08-20","month":8,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO640 \u00b7 \u26052 \u00b7 _DSC5937"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-01","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 275mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC09523"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/7.1 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC3619"},{"species":"Brown Thornbill","location_name":"Tootgarook Wetlands","date":"2024-02-16","month":2,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/2000s \u00b7 f/9.0 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC6024"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC09697"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC09736"},{"species":"Black-shouldered Kite","location_name":"Tootgarook Wetlands","date":"2024-02-22","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 _DSC8186"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-13","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC05632"},{"species":"Yellow-tailed Black Cockatoo","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 400mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC00933"},{"species":"Brown Thornbill","location_name":"","date":"2025-01-16","month":1,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 _DSC6427"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-29","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 582mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC07744"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC09781"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-27","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO5000 \u00b7 \u26052 \u00b7 DSC05023"},{"species":"Australasian Harrier","location_name":"Tootgarook Wetlands","date":"2025-08-18","month":8,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO800 \u00b7 \u26052 \u00b7 _DSC5214"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 _DSC0658"},{"species":"Brown Thornbill","location_name":"Tootgarook Wetlands","date":"2024-02-16","month":2,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/2000s \u00b7 f/9.0 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC6029"},{"species":"Sulphur-crested Cockatoo","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO8000 \u00b7 \u26052 \u00b7 DSC04203"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC7044"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26054 \u00b7 DSC03411"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC09409"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC04986"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC05013"},{"species":"Black-shouldered Kite","location_name":"Tootgarook Wetlands","date":"2024-02-16","month":2,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO320 \u00b7 \u26052 \u00b7 _DSC5430"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC03618"},{"species":"Brown Thornbill","location_name":"","date":"2025-01-16","month":1,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 _DSC6061"},{"species":"Black-shouldered Kite","location_name":"Tootgarook Wetlands","date":"2024-02-22","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO5000 \u00b7 \u26054 \u00b7 _DSC8191"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 DSC05186"},{"species":"Black-shouldered Kite","location_name":"","date":"2021-12-03","month":12,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO800 \u00b7 \u26052 \u00b7 _DSC4864"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-27","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO8000 \u00b7 \u26052 \u00b7 DSC05020"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC0887"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC09560"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC04983"},{"species":"Yellow-tailed Black Cockatoo","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 368mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC01047"},{"species":"Eastern Rosella","location_name":"Hillview Reserve","date":"2026-01-27","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC04676"},{"species":"Black-shouldered Kite","location_name":"","date":"2021-12-03","month":12,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/5000s \u00b7 f/6.3 \u00b7 ISO500 \u00b7 \u26052 \u00b7 _DSC5038"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC03901"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC7034"},{"species":"Black-shouldered Kite","location_name":"","date":"2021-12-03","month":12,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO640 \u00b7 \u26052 \u00b7 _DSC5492"},{"species":"Eastern Spinebill","location_name":"","date":"2024-02-14","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO800 \u00b7 \u26052 \u00b7 _DSC2459"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 633mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC0198"},{"species":"Crimson Rosella","location_name":"","date":"2025-11-23","month":11,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/8.0 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 _DSC5565"},{"species":"Black-shouldered Kite","location_name":"Tootgarook Wetlands","date":"2024-02-22","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC8128"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 _DSC7091"},{"species":"Yellow-tailed Black Cockatoo","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 411mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC00883"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-01-25","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO640 \u00b7 \u26052 \u00b7 DSC04175"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 DSC05242"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/7.1 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 _DSC3564"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO5000 \u00b7 \u26052 \u00b7 _DSC4696"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC0653"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 DSC04655"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO5000 \u00b7 \u26052 \u00b7 DSC09714"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC4728"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 DSC09718-2"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-01","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 275mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC09537"},{"species":"Yellow-tailed Black Cockatoo","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 368mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC01025"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC05035"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO640 \u00b7 \u26052 \u00b7 DSC09533-2"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC00300"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 666mm eq \u00b7 1/6400s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26054 \u00b7 _DSC7108"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-19","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC08796"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-26","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC04464"},{"species":"Black-shouldered Kite","location_name":"","date":"2023-10-13","month":10,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 400mm eq \u00b7 1/5000s \u00b7 f/8.0 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 _DSC7571"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-01-23","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO320 \u00b7 \u26052 \u00b7 DSC03512"},{"species":"Crimson Rosella","location_name":"","date":"2025-03-12","month":3,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 700mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 _DSC8607"},{"species":"Crimson Rosella","location_name":"","date":"2025-11-23","month":11,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/5000s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC5215"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC09373"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-14","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC06471"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-28","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 397mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC06231"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-03","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC9658"},{"species":"Peregrine Falcon","location_name":"Cape Schanck Lighthouse","date":"2023-11-17","month":11,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/1600s \u00b7 f/7.1 \u00b7 ISO800 \u00b7 \u26052 \u00b7 _DSC7566"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-03","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC00430"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/800s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC4629"},{"species":"Barn Owl","location_name":"","date":"2026-01-28","month":1,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC06431"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-01-24","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/2000s \u00b7 f/6.3 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC03719"},{"species":"Eastern Rosella","location_name":"Hillview Reserve","date":"2026-01-27","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC04736"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-01","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 500mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC08997"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-22","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO8000 \u00b7 \u26052 \u00b7 DSC02994"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/7.1 \u00b7 ISO640 \u00b7 \u26052 \u00b7 _DSC0630-2"},{"species":"Yellow-tailed Black Cockatoo","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 400mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC00947"},{"species":"Sulphur-crested Cockatoo","location_name":"","date":"2026-02-10","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 397mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC05322"},{"species":"Hooded Plover","location_name":"","date":"2024-01-02","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/2000s \u00b7 f/6.3 \u00b7 ISO640 \u00b7 \u26052 \u00b7 _DSC2257"},{"species":"Eastern Rosella","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO8000 \u00b7 \u26052 \u00b7 DSC09649"},{"species":"Yellow-tailed Black Cockatoo","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 400mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC00954"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-01-23","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO640 \u00b7 \u26052 \u00b7 DSC03592"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 559mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC00544"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-01-24","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC03751"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC09411"},{"species":"Brown Thornbill","location_name":"","date":"2025-08-22","month":8,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/8.0 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 _DSC6314"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO640 \u00b7 \u26052 \u00b7 DSC09525-2"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC03177"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC04554"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-26","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 DSC04399"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC09501"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 655mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC8341"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 _DSC8284"},{"species":"Yellow-tailed Black Cockatoo","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 368mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC01038"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-03","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC00433"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC7047"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC09541"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-01","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 500mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC09001"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-19","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC08705"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC09443"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC03902"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC09440"},{"species":"Black-shouldered Kite","location_name":"Tootgarook Wetlands","date":"2024-02-22","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 820mm eq \u00b7 1/1000s \u00b7 f/6.3 \u00b7 ISO8000 \u00b7 \u26052 \u00b7 _DSC8359"},{"species":"Eastern Rosella","location_name":"Hillview Reserve","date":"2026-01-27","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC04622"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC0665"},{"species":"Hooded Plover","location_name":"","date":"2024-01-02","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/2500s \u00b7 f/7.1 \u00b7 ISO640 \u00b7 \u26052 \u00b7 _DSC2383"},{"species":"Black-shouldered Kite","location_name":"","date":"2021-12-03","month":12,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/3200s \u00b7 f/6.3 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 _DSC5514"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-26","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 DSC04260"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/7.1 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC3634"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 _DSC4282"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC09451"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-28","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC05579"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-14","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 DSC06223"},{"species":"Yellow-tailed Black Cockatoo","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 368mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC01055"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC09362"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-03","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 _DSC9637"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO640 \u00b7 \u26052 \u00b7 DSC09364"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC09562"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-01-23","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO640 \u00b7 \u26052 \u00b7 DSC03582"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-29","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 DSC07653"},{"species":"Yellow-tailed Black Cockatoo","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 385mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC01169"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 559mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 DSC00624"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO640 \u00b7 \u26052 \u00b7 DSC09436"},{"species":"Crimson Rosella","location_name":"","date":"2025-10-17","month":10,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 200mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO10000 \u00b7 \u26052 \u00b7 _DSC2548"},{"species":"Inland Thornbill","location_name":"","date":"2024-02-14","month":2,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/7.1 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC2279"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-01","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC09280"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-29","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 678mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC07714"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-01","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC09202"},{"species":"Black Swan","location_name":"Hillview Reserve","date":"2026-01-22","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 711mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 DSC03443"},{"species":"Peregrine Falcon","location_name":"","date":"2025-10-10","month":10,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/8.0 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 _DSC0032"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC03178"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-28","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC06340"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-14","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC06046"},{"species":"Black-shouldered Kite","location_name":"Tootgarook Wetlands","date":"2024-02-22","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC7093"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-10","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC05382"},{"species":"Brown Thornbill","location_name":"Tootgarook Wetlands","date":"2024-02-22","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/2000s \u00b7 f/6.3 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 _DSC6865"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-01","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26053 \u00b7 DSC09298"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-28","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC05612"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC6951"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-03","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC9313"},{"species":"Australasian Grebe","location_name":"","date":"2023-10-20","month":10,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/5000s \u00b7 f/7.1 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 _DSC8395"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-22","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO5000 \u00b7 \u26052 \u00b7 DSC02866"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC09542-2"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-01","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC09349"},{"species":"Sulphur-crested Cockatoo","location_name":"","date":"2026-01-31","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 DSC08557"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-28","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 397mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC06263"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 _DSC8336"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 DSC05188"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC04543"},{"species":"Yellow-tailed Black Cockatoo","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 350mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26054 \u00b7 DSC01003"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 _DSC0662-2"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC09559"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 _DSC3658"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-01-25","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO250 \u00b7 \u26052 \u00b7 DSC03983"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-19","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC08695"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/800s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC4650"},{"species":"Yellow-tailed Black Cockatoo","location_name":"","date":"2021-09-26","month":9,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO1250 \u00b7 \u26054 \u00b7 _DSC6150"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC09689"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC7046"},{"species":"Black-shouldered Kite","location_name":"","date":"2021-12-03","month":12,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/5000s \u00b7 f/6.3 \u00b7 ISO640 \u00b7 \u26052 \u00b7 _DSC5355"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-27","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO10000 \u00b7 \u26052 \u00b7 DSC05009"},{"species":"Pied Cormorant","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC0572"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 DSC09726"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC09419"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC09434"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-01-25","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO320 \u00b7 \u26052 \u00b7 DSC03990"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC04470"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2025-12-13","month":12,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 _DSC1134"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 586mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 _DSC8134"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-26","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/3200s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 DSC04446"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-29","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 661mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 DSC07708"},{"species":"Sulphur-crested Cockatoo","location_name":"","date":"2026-01-31","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO8000 \u00b7 \u26052 \u00b7 DSC08552"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC04580"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC03447-2"},{"species":"Black-shouldered Kite","location_name":"Tootgarook Wetlands","date":"2024-02-22","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO10000 \u00b7 \u26052 \u00b7 _DSC8260"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-03","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 DSC00426"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/2500s \u00b7 f/7.1 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC00106"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC09456"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC03314"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-12","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC05569"},{"species":"Crimson Rosella","location_name":"","date":"2025-09-22","month":9,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 334mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC8737"},{"species":"Black-shouldered Kite","location_name":"","date":"2021-12-04","month":12,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/8000s \u00b7 f/6.3 \u00b7 ISO800 \u00b7 \u26052 \u00b7 _DSC5787"},{"species":"Black-shouldered Kite","location_name":"","date":"2021-12-03","month":12,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/5000s \u00b7 f/6.3 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC5162"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC8290"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 DSC00187"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC05005"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-01-24","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC03737"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 595mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 _DSC8459"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 649mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC8108"},{"species":"Crimson Rosella","location_name":"","date":"2025-10-17","month":10,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 200mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO10000 \u00b7 \u26052 \u00b7 _DSC2555-2"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/800s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC4653"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-19","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 463mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC08735"},{"species":"Sulphur-crested Cockatoo","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO8000 \u00b7 \u26052 \u00b7 DSC04204"},{"species":"Black-shouldered Kite","location_name":"","date":"2021-11-19","month":11,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/5000s \u00b7 f/7.1 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC3840"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-01-23","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1000s \u00b7 f/6.3 \u00b7 ISO250 \u00b7 \u26052 \u00b7 DSC03669"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-01","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 DSC09344"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO640 \u00b7 \u26052 \u00b7 DSC00740"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 559mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC00578"},{"species":"Black-shouldered Kite","location_name":"Tootgarook Wetlands","date":"2024-02-23","month":2,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 _DSC0033"},{"species":"Black Swan","location_name":"Hillview Reserve","date":"2026-01-22","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 711mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 DSC03436"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-03","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO5000 \u00b7 \u26052 \u00b7 _DSC9320"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC00031"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-01-23","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC03587"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 559mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC00545"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO400 \u00b7 \u26052 \u00b7 DSC03762"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-14","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 DSC06152"},{"species":"Yellow-tailed Black Cockatoo","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 400mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC00948"},{"species":"Brown Goshawk","location_name":"Tootgarook Wetlands","date":"2024-02-16","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC6360"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC09772"},{"species":"Black-shouldered Kite","location_name":"","date":"2021-12-03","month":12,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO640 \u00b7 \u26052 \u00b7 _DSC5415"},{"species":"Mistletoebird","location_name":"","date":"2024-04-19","month":4,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC8890"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2025-12-13","month":12,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO800 \u00b7 \u26052 \u00b7 _DSC1153"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-29","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 678mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC07720"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-28","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC06101"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-14","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC06114"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/7.1 \u00b7 ISO640 \u00b7 \u26052 \u00b7 _DSC0634-2"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/7.1 \u00b7 ISO640 \u00b7 \u26052 \u00b7 _DSC0633"},{"species":"European Goldfinch","location_name":"Tootgarook Wetlands","date":"2024-02-15","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/2000s \u00b7 f/6.3 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 _DSC3950"},{"species":"Eastern Rosella","location_name":"Hillview Reserve","date":"2026-01-27","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC04734"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC04584"},{"species":"Sulphur-crested Cockatoo","location_name":"","date":"2026-01-31","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 DSC08555"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC03904"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1600s \u00b7 f/7.1 \u00b7 ISO400 \u00b7 \u26052 \u00b7 _DSC7883"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC04650"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-19","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC08714"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-01","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC09196"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-14","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC06036"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-01-24","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC03728"},{"species":"Black-shouldered Kite","location_name":"","date":"2021-12-03","month":12,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/5000s \u00b7 f/6.3 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC5188"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC09376"},{"species":"Nankeen Kestrel","location_name":"","date":"2024-01-18","month":1,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/800s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC8671"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-14","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC06188"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC09500"},{"species":"Nankeen Kestrel","location_name":"","date":"2024-01-04","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/3200s \u00b7 f/6.3 \u00b7 ISO800 \u00b7 \u26052 \u00b7 _DSC3815"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-29","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC07722"},{"species":"Grey Butcherbird","location_name":"Hillview Reserve","date":"2026-01-22","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC03350"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC09455"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-01","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 275mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC09526"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC09439"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-03","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 _DSC9322"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC09514"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-01-24","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC03727"},{"species":"Australian Magpie","location_name":"","date":"2023-09-22","month":9,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 513mm eq \u00b7 1/3200s \u00b7 f/8.0 \u00b7 ISO500 \u00b7 \u26052 \u00b7 _DSC5244"},{"species":"Crimson Rosella","location_name":"","date":"2025-11-22","month":11,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 300mm eq \u00b7 1/5000s \u00b7 f/5.6 \u00b7 ISO5000 \u00b7 \u26052 \u00b7 _DSC5042-2"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/7.1 \u00b7 ISO500 \u00b7 \u26052 \u00b7 _DSC3681"},{"species":"Crimson Rosella","location_name":"","date":"2025-10-09","month":10,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 200mm eq \u00b7 1/5000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 _DSC9801"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-19","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC08698"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-01-23","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1000s \u00b7 f/6.3 \u00b7 ISO200 \u00b7 \u26052 \u00b7 DSC03664"},{"species":"Black-shouldered Kite","location_name":"Tootgarook Wetlands","date":"2024-02-16","month":2,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO250 \u00b7 \u26052 \u00b7 _DSC5428"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-01-23","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1000s \u00b7 f/6.3 \u00b7 ISO320 \u00b7 \u26052 \u00b7 DSC03638"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO5000 \u00b7 \u26052 \u00b7 DSC00202"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 _DSC0664-2"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 595mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO8000 \u00b7 \u26052 \u00b7 _DSC8455"},{"species":"Eastern Rosella","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC01283"},{"species":"Rainbow Lorikeet","location_name":"Hillview Reserve","date":"2026-01-28","month":1,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 444mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO8000 \u00b7 \u26052 \u00b7 DSC05425"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/7.1 \u00b7 ISO800 \u00b7 \u26052 \u00b7 _DSC0604-2"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-03","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 _DSC9127"},{"species":"Black Swan","location_name":"Hillview Reserve","date":"2026-01-22","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 711mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 DSC03444"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO640 \u00b7 \u26052 \u00b7 DSC09507-2"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-03","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/2000s \u00b7 f/7.1 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 _DSC9609"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-03","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 _DSC8988"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-01","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 275mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC09529"},{"species":"Black-shouldered Kite","location_name":"","date":"2021-12-03","month":12,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO640 \u00b7 \u26052 \u00b7 _DSC5470"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1600s \u00b7 f/7.1 \u00b7 ISO320 \u00b7 \u26052 \u00b7 _DSC7888"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-16","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 588mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC07500"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC09366"},{"species":"Barn Owl","location_name":"","date":"2026-01-28","month":1,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 467mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC06429"},{"species":"Black-shouldered Kite","location_name":"","date":"2021-12-03","month":12,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/5000s \u00b7 f/6.3 \u00b7 ISO800 \u00b7 \u26052 \u00b7 _DSC5382"},{"species":"Sulphur-crested Cockatoo","location_name":"","date":"2026-01-31","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC08543"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC09503-2"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-29","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO10000 \u00b7 \u26052 \u00b7 DSC07528"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-10","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC05388"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC09565"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-01-23","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1000s \u00b7 f/6.3 \u00b7 ISO320 \u00b7 \u26052 \u00b7 DSC03660"},{"species":"Brown Thornbill","location_name":"","date":"2024-01-14","month":1,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1000s \u00b7 f/7.1 \u00b7 ISO400 \u00b7 \u26052 \u00b7 _DSC7500"},{"species":"Barn Owl","location_name":"","date":"2026-01-28","month":1,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC06430"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2025-12-13","month":12,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO800 \u00b7 \u26052 \u00b7 _DSC1101"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-07","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 DSC02399"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-01","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 275mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC09533"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-03","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO5000 \u00b7 \u26052 \u00b7 _DSC9326"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC03409"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-22","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC03196"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-03","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC9150"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC04567"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC09770"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-27","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC05043"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-01","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 DSC09343"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-01-23","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO400 \u00b7 \u26052 \u00b7 DSC03576"},{"species":"Crimson Rosella","location_name":"","date":"2025-11-23","month":11,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 694mm eq \u00b7 1/1600s \u00b7 f/8.0 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 _DSC5374"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO640 \u00b7 \u26052 \u00b7 DSC09539"},{"species":"Black-shouldered Kite","location_name":"","date":"2023-10-13","month":10,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 400mm eq \u00b7 1/5000s \u00b7 f/8.0 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 _DSC7578"},{"species":"Sulphur-crested Cockatoo","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO5000 \u00b7 \u26052 \u00b7 DSC04156"},{"species":"Sulphur-crested Cockatoo","location_name":"","date":"2026-01-31","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO10000 \u00b7 \u26052 \u00b7 DSC08545"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/7.1 \u00b7 ISO500 \u00b7 \u26052 \u00b7 _DSC0645"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 _DSC6913"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC00353"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC04985"},{"species":"Collared Sparrowhawk","location_name":"Tootgarook Wetlands","date":"2024-02-16","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC6363"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-19","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC08757"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2025-12-13","month":12,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 _DSC1125"},{"species":"Eastern Spinebill","location_name":"","date":"2025-01-14","month":1,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC4978"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC05033"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/7.1 \u00b7 ISO800 \u00b7 \u26052 \u00b7 _DSC0635"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC7040"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-01","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 DSC09311"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-01","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 275mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC09527"},{"species":"Crimson Rosella","location_name":"","date":"2025-11-22","month":11,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 300mm eq \u00b7 1/5000s \u00b7 f/5.6 \u00b7 ISO5000 \u00b7 \u26052 \u00b7 _DSC5041"},{"species":"Australian White Ibis","location_name":"Tootgarook Wetlands","date":"2024-02-16","month":2,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 330mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO125 \u00b7 \u26052 \u00b7 _DSC6014"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-29","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC07476"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO640 \u00b7 \u26052 \u00b7 DSC09536-2"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 437mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 _DSC7833"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC09496"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-03","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC00435"},{"species":"Black-shouldered Kite","location_name":"","date":"2021-12-03","month":12,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/5000s \u00b7 f/6.3 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC5110"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC00354"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-26","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO8000 \u00b7 \u26052 \u00b7 DSC04264"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-22","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC03205"},{"species":"Black-shouldered Kite","location_name":"","date":"2021-12-03","month":12,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/5000s \u00b7 f/6.3 \u00b7 ISO800 \u00b7 \u26052 \u00b7 _DSC5245"},{"species":"Yellow-tailed Black Cockatoo","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 368mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC01042"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-07","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 DSC02397"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-28","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC06324"},{"species":"Pied Cormorant","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 _DSC0578-2"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC05001"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 561mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC8226"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-29","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC07520"},{"species":"Crimson Rosella","location_name":"","date":"2025-11-23","month":11,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/8.0 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 _DSC5557"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/7.1 \u00b7 ISO640 \u00b7 \u26052 \u00b7 _DSC0641-2"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC09729"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-03","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 _DSC9134"},{"species":"Black-shouldered Kite","location_name":"","date":"2021-12-03","month":12,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/5000s \u00b7 f/6.3 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC5189"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-29","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC07915"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC05061"},{"species":"Nankeen Kestrel","location_name":"","date":"2024-01-04","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO640 \u00b7 \u26052 \u00b7 _DSC3404"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-26","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/3200s \u00b7 f/6.3 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC04448"},{"species":"Sulphur-crested Cockatoo","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO5000 \u00b7 \u26052 \u00b7 DSC04153"},{"species":"Black-shouldered Kite","location_name":"Tootgarook Wetlands","date":"2024-02-15","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/2000s \u00b7 f/6.3 \u00b7 ISO250 \u00b7 \u26052 \u00b7 _DSC3722"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC05007"},{"species":"Eastern Rosella","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC01278"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-01","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC09206"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC09681"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 _DSC0722"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 405mm eq \u00b7 1/5000s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 _DSC6006"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-01-24","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC03730"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-14","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC06185"},{"species":"Sulphur-crested Cockatoo","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO5000 \u00b7 \u26052 \u00b7 DSC04163"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC09495"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC7050"},{"species":"Black Swan","location_name":"Hillview Reserve","date":"2026-01-22","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 711mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 DSC03438"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO400 \u00b7 \u26052 \u00b7 DSC03764"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC04988"},{"species":"Nankeen Kestrel","location_name":"","date":"2024-01-18","month":1,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/800s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 _DSC8647"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-19","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC08700"},{"species":"Crimson Rosella","location_name":"","date":"2025-11-23","month":11,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/8.0 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC5610"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/2000s \u00b7 f/7.1 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 _DSC4452"},{"species":"Yellow-tailed Black Cockatoo","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 385mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC01165"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC09433"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-28","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC06104"},{"species":"Great Egret","location_name":"","date":"2024-05-01","month":5,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 _DSC2229"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-07","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC02693"},{"species":"Black-shouldered Kite","location_name":"","date":"2021-12-03","month":12,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/5000s \u00b7 f/6.3 \u00b7 ISO500 \u00b7 \u26052 \u00b7 _DSC5037"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC09523-2"},{"species":"Australasian Harrier","location_name":"Tootgarook Wetlands","date":"2025-08-20","month":8,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO640 \u00b7 \u26052 \u00b7 _DSC5848"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-26","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO10000 \u00b7 \u26052 \u00b7 DSC04472"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC09365"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2025-12-13","month":12,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 _DSC1183"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO640 \u00b7 \u26052 \u00b7 DSC09538-2"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC8074"},{"species":"Black-shouldered Kite","location_name":"","date":"2023-10-13","month":10,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/2000s \u00b7 f/7.1 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC7529"},{"species":"Yellow-tailed Black Cockatoo","location_name":"","date":"2021-11-06","month":11,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/5.6 \u00b7 ISO1600 \u00b7 \u26054 \u00b7 _DSC2724"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC7036"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-16","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1250s \u00b7 f/8.0 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC08081"},{"species":"Crimson Rosella","location_name":"","date":"2025-10-09","month":10,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 200mm eq \u00b7 1/5000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 _DSC9836"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 DSC09694"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC03326"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1600s \u00b7 f/7.1 \u00b7 ISO320 \u00b7 \u26052 \u00b7 _DSC7891"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC04492"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-26","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 DSC04397"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC09524"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-28","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC06311"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-29","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 661mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 DSC07706"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-28","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC05505"},{"species":"Brown Thornbill","location_name":"","date":"2024-02-26","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO640 \u00b7 \u26052 \u00b7 _DSC1240"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 595mm eq \u00b7 1/5000s \u00b7 f/6.3 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC6585"},{"species":"Eastern Rosella","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC01277"},{"species":"Grey Shrike-thrush","location_name":"","date":"2026-01-12","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC01733"},{"species":"Crimson Rosella","location_name":"","date":"2025-10-09","month":10,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 200mm eq \u00b7 1/6400s \u00b7 f/7.1 \u00b7 ISO8000 \u00b7 \u26052 \u00b7 _DSC9796"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC09494"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-29","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC07522"},{"species":"Sulphur-crested Cockatoo","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO8000 \u00b7 \u26052 \u00b7 DSC04207"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC09682"},{"species":"Sulphur-crested Cockatoo","location_name":"","date":"2026-01-31","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO5000 \u00b7 \u26052 \u00b7 DSC08560"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC09410"},{"species":"Peregrine Falcon","location_name":"","date":"2025-10-10","month":10,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 _DSC9898"},{"species":"Eastern Rosella","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC09615"},{"species":"Brown Thornbill","location_name":"","date":"2025-01-14","month":1,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 _DSC5140"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC04473"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-27","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC04896"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-01-24","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC03724"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 739mm eq \u00b7 1/5000s \u00b7 f/6.3 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 _DSC8545"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-28","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC05504"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO640 \u00b7 \u26052 \u00b7 DSC09528-2"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC09432"},{"species":"Eastern Rosella","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO8000 \u00b7 \u26052 \u00b7 DSC09647"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/7.1 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC3616"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1600s \u00b7 f/7.1 \u00b7 ISO500 \u00b7 \u26052 \u00b7 _DSC7978"},{"species":"Black-shouldered Kite","location_name":"Tootgarook Wetlands","date":"2024-02-22","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 820mm eq \u00b7 1/800s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC8301"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/7.1 \u00b7 ISO800 \u00b7 \u26052 \u00b7 _DSC0638-2"},{"species":"Black-shouldered Kite","location_name":"","date":"2023-10-13","month":10,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 400mm eq \u00b7 1/5000s \u00b7 f/8.0 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 _DSC7579"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC09454"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-26","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO10000 \u00b7 \u26052 \u00b7 DSC04265"},{"species":"Crimson Rosella","location_name":"","date":"2025-11-23","month":11,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/5000s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC5209"},{"species":"Superb Fairy-wren","location_name":"Tootgarook Wetlands","date":"2025-02-03","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1000s \u00b7 f/7.1 \u00b7 ISO640 \u00b7 \u26052 \u00b7 _DSC7763"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC00758"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC03903"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-03","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO800 \u00b7 \u26052 \u00b7 _DSC8968"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 DSC05187"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-27","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO8000 \u00b7 \u26052 \u00b7 DSC04982"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-26","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/3200s \u00b7 f/6.3 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 DSC04445"},{"species":"Black-shouldered Kite","location_name":"","date":"2023-10-13","month":10,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/1600s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC7517"},{"species":"Eastern Rosella","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC09667"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC7041"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-19","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC08696-2"},{"species":"Yellow-tailed Black Cockatoo","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 368mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC01054"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC00025"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-28","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC06112"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/7.1 \u00b7 ISO800 \u00b7 \u26052 \u00b7 _DSC0640"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC7043"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO400 \u00b7 \u26052 \u00b7 DSC03761"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2025-12-13","month":12,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 _DSC1188"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 _DSC0659"},{"species":"Yellow-tailed Black Cockatoo","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 547mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC01108"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-16","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 588mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC07477"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/7.1 \u00b7 ISO640 \u00b7 \u26052 \u00b7 _DSC3683"},{"species":"Australian Pied Oystercatcher","location_name":"","date":"2025-04-06","month":4,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO100 \u00b7 \u26052 \u00b7 _DSC0268"},{"species":"Yellow-tailed Black Cockatoo","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 368mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC01048"},{"species":"Brown Thornbill","location_name":"Tootgarook Wetlands","date":"2024-02-22","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/2000s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC6999"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC7015"},{"species":"Peregrine Falcon","location_name":"","date":"2025-10-10","month":10,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 _DSC9896"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO16000 \u00b7 \u26052 \u00b7 _DSC4211"},{"species":"Black-shouldered Kite","location_name":"Tootgarook Wetlands","date":"2024-02-22","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC7105"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 DSC09716"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC03456"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-19","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC08734"},{"species":"Sulphur-crested Cockatoo","location_name":"Tootgarook Wetlands","date":"2024-02-07","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/800s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC0312"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-03","month":12,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 _DSC8865"},{"species":"Crimson Rosella","location_name":"","date":"2025-11-22","month":11,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 300mm eq \u00b7 1/5000s \u00b7 f/5.6 \u00b7 ISO5000 \u00b7 \u26052 \u00b7 _DSC5091-2"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC04562"},{"species":"Pied Cormorant","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 _DSC0583"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-16","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 371mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC08575-2"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 DSC09831"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 559mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC00526"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC04546"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC09874"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-26","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC04250"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-03","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC9315"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-03","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/7.1 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC9314"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC09414"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-28","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC06099"},{"species":"Brown Thornbill","location_name":"","date":"2024-02-14","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/7.1 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 _DSC2541"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-01","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 275mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC09528"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-29","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO8000 \u00b7 \u26052 \u00b7 DSC07924"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 568mm eq \u00b7 1/5000s \u00b7 f/6.3 \u00b7 ISO16000 \u00b7 \u26052 \u00b7 _DSC8605"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC09826"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-03","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/2000s \u00b7 f/7.1 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 _DSC9608"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/800s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC4655"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-03","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/2000s \u00b7 f/7.1 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 _DSC9059"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-03","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC00436"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-01-23","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1000s \u00b7 f/6.3 \u00b7 ISO250 \u00b7 \u26052 \u00b7 DSC03659"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/2500s \u00b7 f/7.1 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 DSC00115"},{"species":"Yellow-tailed Black Cockatoo","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 385mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC01173"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO16000 \u00b7 \u26052 \u00b7 _DSC4209"},{"species":"Yellow-tailed Black Cockatoo","location_name":"","date":"2021-09-26","month":9,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC6153"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC09476"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 DSC09715"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-10","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC05387"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-28","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC06105"},{"species":"Sulphur-crested Cockatoo","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 351mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC04275"},{"species":"Eastern Rosella","location_name":"Hillview Reserve","date":"2026-01-27","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC04598"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC03152"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-28","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC05568"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 744mm eq \u00b7 1/6400s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC7109"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 _DSC4694"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-19","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC08699"},{"species":"Sulphur-crested Cockatoo","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO5000 \u00b7 \u26052 \u00b7 DSC04161"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-01","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC09189"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-27","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO10000 \u00b7 \u26052 \u00b7 DSC05006"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/2500s \u00b7 f/7.1 \u00b7 ISO8000 \u00b7 \u26052 \u00b7 _DSC4551"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC09378"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-19","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC08697"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC09737"},{"species":"Eastern Rosella","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC09669"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC09769"},{"species":"Black-shouldered Kite","location_name":"Tootgarook Wetlands","date":"2024-02-16","month":2,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO320 \u00b7 \u26053 \u00b7 _DSC5429"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-28","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC05918"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC09512"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 _DSC8280"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1600 \u00b7 \u26054 \u00b7 DSC09408"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-10","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC05369"},{"species":"Black-shouldered Kite","location_name":"","date":"2021-12-03","month":12,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/5000s \u00b7 f/6.3 \u00b7 ISO500 \u00b7 \u26052 \u00b7 _DSC5056"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-01-23","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO400 \u00b7 \u26052 \u00b7 DSC03608"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-07","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 DSC02283-2"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC09732"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 565mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 _DSC0826-2"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-01-24","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC03711"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC00083"},{"species":"Black-shouldered Kite","location_name":"","date":"2021-12-04","month":12,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/8000s \u00b7 f/6.3 \u00b7 ISO800 \u00b7 \u26052 \u00b7 _DSC5788"},{"species":"Black-shouldered Kite","location_name":"","date":"2024-01-04","month":1,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/2500s \u00b7 f/6.3 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 _DSC4514"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-29","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 678mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC07716"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-01-23","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC03565"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-28","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO10000 \u00b7 \u26052 \u00b7 DSC05545"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-26","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 DSC04398"},{"species":"Eastern Rosella","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC09612"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC00356"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 _DSC0663-2"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC09492"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-03","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/2000s \u00b7 f/7.1 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 _DSC9050"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC09735"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/7.1 \u00b7 ISO500 \u00b7 \u26052 \u00b7 _DSC0644"},{"species":"Crimson Rosella","location_name":"","date":"2025-10-17","month":10,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 200mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC2512"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC09483"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-26","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 DSC04369"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-29","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 582mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC07745"},{"species":"Yellow-tailed Black Cockatoo","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 368mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC01037"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-28","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 397mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC06274"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 564mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC0089"},{"species":"Black-shouldered Kite","location_name":"Tootgarook Wetlands","date":"2024-02-22","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC8222"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC09450"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1250 \u00b7 \u26052 \u00b7 DSC09421"},{"species":"Black-shouldered Kite","location_name":"Tootgarook Wetlands","date":"2024-02-02","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO160 \u00b7 \u26052 \u00b7 _DSC0091"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-03","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC00429"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC04984"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO5000 \u00b7 \u26052 \u00b7 DSC09665"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-03","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC9639"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 586mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 _DSC8136"},{"species":"Sulphur-crested Cockatoo","location_name":"","date":"2026-02-10","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 397mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC05319"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-27","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC05078"},{"species":"Crimson Rosella","location_name":"","date":"2025-02-01","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 375mm eq \u00b7 1/4000s \u00b7 f/5.6 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 _DSC7083"},{"species":"Sulphur-crested Cockatoo","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO10000 \u00b7 \u26054 \u00b7 DSC04196"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 564mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 _DSC0236"},{"species":"Barn Owl","location_name":"","date":"2026-01-28","month":1,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 444mm eq \u00b7 1/2000s \u00b7 f/8.0 \u00b7 ISO1250 \u00b7 \u26054 \u00b7 DSC06710-2"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC7038"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-15","month":2,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC07286"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/6400s \u00b7 f/7.1 \u00b7 ISO3200 \u00b7 \u26052 \u00b7 _DSC4120"},{"species":"Sulphur-crested Cockatoo","location_name":"","date":"2026-01-31","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO8000 \u00b7 \u26052 \u00b7 DSC08547"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-09","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 DSC04572"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-01","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO8000 \u00b7 \u26052 \u00b7 DSC08770"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 DSC09485"},{"species":"Sulphur-crested Cockatoo","location_name":"","date":"2026-01-31","month":1,"time_of_day":"Dusk","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 DSC08554"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-21","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO800 \u00b7 \u26052 \u00b7 DSC09363"},{"species":"Blue-winged Fairy-wren","location_name":"","date":"2024-04-27","month":4,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 _DSC0725"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-26","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC04327"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-02","month":2,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 DSC00075"},{"species":"Brown Thornbill","location_name":"","date":"2024-01-14","month":1,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1000s \u00b7 f/7.1 \u00b7 ISO400 \u00b7 \u26052 \u00b7 _DSC7493"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 _DSC3528"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-29","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 385mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 DSC07704"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2026-02-19","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/4000s \u00b7 f/8.0 \u00b7 ISO1250 \u00b7 \u26054 \u00b7 DSC08921"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-26","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 600mm eq \u00b7 1/6400s \u00b7 f/6.3 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 _DSC8224"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/1250s \u00b7 f/6.3 \u00b7 ISO5000 \u00b7 \u26052 \u00b7 _DSC4713"},{"species":"Black-shouldered Kite","location_name":"Coolart Wetlands","date":"2023-10-27","month":10,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 600mm eq \u00b7 1/6400s \u00b7 f/8.0 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC1015"},{"species":"Superb Fairy-wren","location_name":"","date":"2026-02-04","month":2,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 559mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO12800 \u00b7 \u26052 \u00b7 DSC00527"},{"species":"Superb Fairy-wren","location_name":"Hillview Reserve","date":"2026-01-29","month":1,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 661mm eq \u00b7 1/1600s \u00b7 f/6.3 \u00b7 ISO6400 \u00b7 \u26052 \u00b7 DSC07710"},{"species":"Crimson Rosella","location_name":"","date":"2025-11-23","month":11,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/5000s \u00b7 f/6.3 \u00b7 ISO4000 \u00b7 \u26052 \u00b7 _DSC5207"},{"species":"Peregrine Falcon","location_name":"","date":"2025-12-10","month":12,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO2000 \u00b7 \u26052 \u00b7 _DSC0655"},{"species":"Peregrine Falcon","location_name":"","date":"2025-11-19","month":11,"time_of_day":"Afternoon","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/7.1 \u00b7 ISO16000 \u00b7 \u26052 \u00b7 _DSC4489"},{"species":"Black-shouldered Kite","location_name":"","date":"2023-10-27","month":10,"time_of_day":"Dawn","behaviour":"","count":1,"notes":"FE 100-400mm F4.5-5.6 GM OSS \u00b7 577mm eq \u00b7 1/6400s \u00b7 f/9.0 \u00b7 ISO2500 \u00b7 \u26052 \u00b7 _DSC1085"},{"species":"Wedge-tailed Eagle","location_name":"","date":"2025-12-13","month":12,"time_of_day":"Morning","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1000 \u00b7 \u26052 \u00b7 _DSC1136"},{"species":"Rainbow Lorikeet","location_name":"","date":"2026-02-08","month":2,"time_of_day":"Midday","behaviour":"","count":1,"notes":"FE 200-600mm F5.6-6.3 G OSS \u00b7 900mm eq \u00b7 1/4000s \u00b7 f/6.3 \u00b7 ISO1600 \u00b7 \u26052 \u00b7 DSC03905"}];

const NEW_LOCATIONS_FROM_XMP = [
  { name:"Tootgarook Wetlands",    lat:-38.1961, lng:144.8917, type:"both", tags:["wetlands","waterbirds","waders","shorebirds"],  notes:"Seasonal wetlands near Tootgarook. Good for waders and waterbirds." },
  { name:"Hillview Reserve",       lat:-38.3480, lng:144.9630, type:"both", tags:["small-birds","parrots","forest"],               notes:"Bushland reserve. Regular fairy-wren, pardalote and honeyeater activity." },
  { name:"Seawinds Gardens",       lat:-38.3769, lng:145.0019, type:"both", tags:["small-birds","parrots","garden","landscape"],   notes:"Arthurs Seat State Park gardens. Diverse small birds and rosellas." },
  { name:"Edithvale Wetlands",     lat:-38.0167, lng:145.1000, type:"both", tags:["wetlands","waterbirds","waders","shorebirds"],  notes:"Edithvale-Seaford Wetlands. Significant migratory shorebird site." },
  { name:"Port Phillip Bay",       lat:-38.1500, lng:144.9000, type:"both", tags:["coastal","seabirds","landscape","shorebirds"], notes:"Bay coastline. Good for coastal and seabird photography." },
];

// ─── STYLES ───────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=DM+Sans:wght@300;400;500;600&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --ink:#0a0a14;--ink2:#14142a;--ink3:#1e1e38;
  --gold:#c9a84c;--gold2:#e8c96a;--gold3:rgba(201,168,76,0.13);
  --dawn:#ff8c42;--dusk:#9b6fc4;--night:#2a4480;
  --sky:#4a90d9;--green:#27ae60;--amber:#e67e22;--red:#e74c3c;
  --paper:#f0ebe0;--paper2:#a8a090;
  --glass:rgba(255,255,255,0.04);--glass2:rgba(255,255,255,0.08);
  --border:rgba(201,168,76,0.16);--border2:rgba(255,255,255,0.07);
}
html,body{font-family:'DM Sans',sans-serif;background:var(--ink);color:var(--paper);height:100%}
h4{color:var(--gold2);font-family:'Playfair Display',serif;font-size:0.85rem;margin:10px 0 4px;font-style:italic}
p{font-size:0.78rem;line-height:1.6;color:var(--paper);margin-bottom:6px}
.hdr{display:flex;justify-content:space-between;align-items:center;padding:10px 18px;background:linear-gradient(to right,rgba(201,168,76,0.06),transparent);border-bottom:1px solid var(--border)}
.title{font-family:'Playfair Display',serif;font-size:1.1rem;color:var(--gold);font-weight:700;letter-spacing:0.02em}
.subtitle{font-size:0.62rem;color:var(--paper2);letter-spacing:0.05em;text-transform:uppercase;margin-top:1px}
.clock{font-size:1.2rem;font-weight:600;font-variant-numeric:tabular-nums;color:var(--gold2)}
.clock-d{font-size:0.65rem;color:var(--paper2);text-align:right}
.cond-bar{background:var(--ink2);border-bottom:1px solid var(--border);overflow-x:auto;scrollbar-width:none}
.cond-bar::-webkit-scrollbar{display:none}
.cond-inner{display:flex;gap:0;min-width:max-content;padding:0 6px}
.cb{display:flex;flex-direction:column;align-items:center;padding:7px 12px;border-right:1px solid var(--border2);min-width:72px;gap:1px}
.cb-lbl{font-size:0.55rem;color:var(--paper2);text-transform:uppercase;letter-spacing:0.05em;white-space:nowrap}
.cb-val{font-size:0.88rem;font-weight:600;white-space:nowrap}
.cb-sub{font-size:0.6rem;color:var(--paper2);white-space:nowrap}
.cb-val.gold{color:var(--gold)}.cb-val.sky{color:var(--sky)}
.nav{display:flex;background:var(--ink2);border-bottom:1px solid var(--border);overflow-x:auto}
.nt{flex:1;padding:9px 4px;background:none;border:none;color:var(--paper2);font-size:0.72rem;font-weight:500;cursor:pointer;min-width:70px;border-bottom:2px solid transparent;transition:all 0.15s;white-space:nowrap}
.nt.active{color:var(--gold);border-bottom-color:var(--gold);background:var(--gold3)}
.nt:hover:not(.active){background:var(--glass2);color:var(--paper)}
.mg{display:grid;grid-template-columns:300px 1fr;gap:0;min-height:calc(100vh - 160px)}
@media(max-width:700px){.mg{grid-template-columns:1fr}}
.lp{padding:12px 14px;border-right:1px solid var(--border);overflow-y:auto;max-height:calc(100vh - 160px)}
.rp{padding:14px 18px;overflow-y:auto;max-height:calc(100vh - 160px)}
.sh{font-family:'Playfair Display',serif;font-size:0.82rem;color:var(--gold2);font-style:italic;margin:12px 0 6px;border-bottom:1px solid var(--border);padding-bottom:4px}
.lc{padding:9px 10px;border:1px solid var(--border2);border-radius:8px;margin-bottom:6px;cursor:pointer;transition:all 0.15s;position:relative}
.lc:hover{background:var(--glass2);border-color:rgba(201,168,76,0.25)}.lc.sel{background:var(--gold3);border-color:rgba(201,168,76,0.35)}
.lc-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:3px}
.lc-name{font-weight:600;font-size:0.8rem;color:var(--paper)}.lc-dist{font-size:0.63rem;color:var(--paper2)}
.rdot{width:9px;height:9px;border-radius:50%;flex-shrink:0;margin-top:3px}
.rdot.rg{background:#2ecc71;box-shadow:0 0 6px rgba(46,204,113,0.5)}
.rdot.ra{background:#f39c12;box-shadow:0 0 6px rgba(243,156,18,0.4)}
.rdot.rr{background:#e74c3c;box-shadow:0 0 6px rgba(231,76,60,0.4)}
.lc-sum{font-size:0.68rem;color:var(--paper2);line-height:1.45;margin-bottom:3px}
.lc-why{font-size:0.67rem;color:var(--gold2);font-style:italic;line-height:1.4;margin-bottom:4px}
.lc-tags{display:flex;flex-wrap:wrap;gap:3px}
.lt{font-size:0.58rem;padding:1px 5px;background:var(--glass2);border-radius:4px;color:var(--paper2);border:1px solid var(--border2)}
.lc-besttime{font-size:0.63rem;color:rgba(255,140,66,0.9);margin-bottom:3px;font-style:italic}
.lc-wxnote{font-size:0.68rem;color:#e8a94a;margin-top:2px;margin-bottom:2px;line-height:1.4}
.lc-reflnote{font-size:0.68rem;color:#4fc3f7;margin-top:1px;margin-bottom:2px;font-style:italic}
.lc-sunvantage{font-size:0.68rem;color:#ffd54f;margin-top:1px;margin-bottom:2px}
@media(max-width:640px){
  .app{padding:0 0 56px 0}
  .cond-bar{padding:4px 6px}
  .cb{min-width:58px;padding:0 5px}
  .cb-val{font-size:0.8rem}
  .nav{overflow-x:auto}
  .nt{font-size:0.62rem;padding:7px 5px;min-width:58px}
  .mg{grid-template-columns:1fr}
  .lp{border-right:none;max-height:none;padding:8px 10px}
  .rp{padding:10px 12px;max-height:none}
  .lc{padding:9px 10px 7px}
  .lc-name{font-size:0.78rem}
  .wt{font-size:0.6rem;padding:4px 7px}
  .window-tabs{gap:3px;flex-wrap:wrap}
  .fs{gap:4px}
  .fd{width:52px;padding:5px 3px}
  .fd-t{font-size:0.65rem}
  .map-wrap,.map-wrap>div{height:260px!important}
  .chat-input-row{padding:6px 8px}
  .chat-input-row input{font-size:0.8rem}
  .data-sect{padding:10px 10px 8px}
}
@media(max-width:380px){
  .nt{font-size:0.56rem;padding:6px 3px;min-width:48px}
  .cb{min-width:50px;padding:0 3px}
  .lc-name{font-size:0.73rem}
}
.fs{display:flex;gap:5px;margin-bottom:4px;overflow-x:auto;padding-bottom:3px}
.fd{flex:0 0 auto;width:58px;background:var(--glass);border:1px solid var(--border2);border-radius:7px;padding:6px 4px;text-align:center;cursor:pointer;transition:all 0.15s}
.fd.sel{background:var(--gold3);border-color:rgba(201,168,76,0.35)}
.fd-n{font-size:0.58rem;color:var(--paper2);font-weight:600;text-transform:uppercase}
.fd-w{font-size:1rem;margin:2px 0}.fd-m{font-size:0.75rem;margin:1px 0}
.fd-t{font-size:0.72rem;font-weight:600;color:var(--paper)}.fd-r{font-size:0.58rem;color:var(--sky);margin-top:1px}
.cal-nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.cal-mn{font-family:'Playfair Display',serif;font-size:0.85rem;color:var(--gold);font-style:italic}
.cg{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
.cdh{text-align:center;font-size:0.58rem;color:var(--paper2);font-weight:600;padding:2px 0}
.cd{background:var(--glass);border:1px solid var(--border2);border-radius:5px;padding:3px 2px;text-align:center;cursor:pointer;transition:all 0.12s;min-height:42px;display:flex;flex-direction:column;align-items:center;gap:1px}
.cd span{font-size:0.68rem;font-weight:500}.cd.today{border-color:rgba(201,168,76,0.4);background:var(--gold3)}
.cd.sel{background:rgba(201,168,76,0.22);border-color:var(--gold)}.cd:hover:not(.sel){background:var(--glass2)}
.cd-icons{display:flex;align-items:center;justify-content:center;gap:1px}
.cd-moon{font-size:0.7rem;line-height:1}.cd-moon.full{font-size:0.9rem;filter:drop-shadow(0 0 4px rgba(255,220,100,0.7))}
.cd-wx{font-size:0.58rem;line-height:1}
.tw-tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-bottom:12px}
.tw-tab{padding:7px 4px;border:1px solid var(--border2);border-radius:7px;cursor:pointer;text-align:center;transition:all 0.15s;background:var(--glass)}
.tw-tab.active{background:rgba(255,255,255,0.05)}.tw-tab:hover:not(.active){background:var(--glass2)}
.tw-icon{font-size:1rem;display:block;margin-bottom:2px}.tw-name{font-size:0.65rem;font-weight:600;display:block}
.tw-time{font-size:0.55rem;color:var(--paper2);display:block;margin-top:1px}
.ai-card{border:1px solid var(--border);border-radius:9px;padding:13px 14px;margin-bottom:10px}
.ai-lbl{font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.ai-txt{font-size:0.78rem;line-height:1.65;color:var(--paper)}
.ai-txt h4{color:var(--gold2);font-size:0.84rem;margin:12px 0 6px;font-style:italic;letter-spacing:0.01em}
.ai-txt ul{margin:4px 0 8px 0;padding:0;list-style:none}
.ai-txt li{font-size:0.78rem;line-height:1.6;margin-bottom:8px;color:var(--paper);padding:6px 10px;background:rgba(255,255,255,0.03);border-left:2px solid rgba(201,168,76,0.25);border-radius:0 5px 5px 0}
.ai-txt li strong,.ai-txt li b{color:var(--gold2);font-size:0.82rem;display:block;margin-bottom:2px;font-weight:700;letter-spacing:0.01em}
.ai-txt p{margin-bottom:5px}
.ai-txt strong{color:var(--gold2);font-weight:700}
.chat-msg.ai ul{margin:4px 0 4px 0;padding:0;list-style:none}
.chat-msg.ai li{font-size:0.77rem;line-height:1.55;margin-bottom:6px;padding:4px 8px;background:rgba(255,255,255,0.03);border-left:2px solid rgba(201,168,76,0.2);border-radius:0 4px 4px 0}
.chat-msg.ai li strong,.chat-msg.ai li b{color:var(--gold2);font-size:0.8rem;display:block;margin-bottom:1px;font-weight:700}
.chat-msg.ai strong{color:var(--gold2);font-weight:700}
.ai-spin{display:inline-block;width:10px;height:10px;border:2px solid rgba(255,255,255,0.15);border-top-color:var(--sky);border-radius:50%;animation:spin 0.7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.chat-wrap{display:flex;flex-direction:column;height:calc(100vh - 200px);max-height:680px}
.chat-msgs{flex:1;overflow-y:auto;padding:4px 0;display:flex;flex-direction:column;gap:7px;min-height:200px}
.chat-msg{padding:9px 12px;border-radius:9px;font-size:0.79rem;line-height:1.6;max-width:90%}
.chat-msg.user{background:var(--gold3);border:1px solid rgba(201,168,76,0.25);align-self:flex-end;color:var(--paper)}
.chat-msg.ai{background:var(--glass2);border:1px solid var(--border2);align-self:flex-start;color:var(--paper)}
.chat-msg.ai h4{font-size:0.78rem;margin:5px 0 2px}
.chat-input-row{display:flex;gap:6px;padding:8px 0 0;border-top:1px solid var(--border2);margin-top:auto}
.chat-input{flex:1;background:var(--glass2);border:1px solid var(--border2);border-radius:7px;padding:8px 12px;color:var(--paper);font-family:'DM Sans',sans-serif;font-size:0.8rem;outline:none}
.chat-input:focus{border-color:rgba(201,168,76,0.4)}
.chat-suggestions{display:flex;flex-wrap:wrap;gap:4px;padding:5px 0 0}
.chat-sug{font-size:0.63rem;padding:3px 8px;border:1px solid var(--border2);border-radius:10px;cursor:pointer;color:var(--paper2);background:var(--glass);transition:all 0.12s}
.chat-sug:hover{border-color:var(--gold);color:var(--gold);background:var(--gold3)}
.wc-card{border:1px solid;border-radius:8px;padding:10px 14px;margin-bottom:10px}
.wc-lbl{font-size:0.62rem;text-transform:uppercase;letter-spacing:0.07em;opacity:0.7}
.wc-val{font-size:1.1rem;font-weight:700;margin:2px 0}.wc-desc{font-size:0.72rem;opacity:0.85}
.night-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px}
.ng-card{background:var(--glass);border:1px solid var(--border2);border-radius:8px;padding:10px 12px}
.ng-title{font-size:0.62rem;color:var(--paper2);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px}
.ng-val{font-size:0.95rem;font-weight:600;margin-bottom:2px}.ng-sub{font-size:0.65rem;color:var(--paper2)}
.fc{background:var(--glass);border:1px solid var(--border2);border-radius:9px;padding:12px;margin-bottom:10px}
.fr{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:7px}.fr.full{grid-template-columns:1fr}
.fl{font-size:0.65rem;color:var(--paper2);margin-bottom:3px;text-transform:uppercase;letter-spacing:0.04em}
.fi{width:100%;background:var(--ink3);border:1px solid var(--border2);border-radius:5px;padding:5px 8px;color:var(--paper);font-family:'DM Sans',sans-serif;font-size:0.78rem;outline:none}
.fi:focus{border-color:rgba(201,168,76,0.4)}
.btn{padding:5px 12px;border-radius:6px;border:1px solid;cursor:pointer;font-size:0.72rem;font-weight:500;font-family:'DM Sans',sans-serif;transition:all 0.15s}
.btn-g{background:rgba(39,174,96,0.15);color:#2ecc71;border-color:rgba(39,174,96,0.3)}
.btn-o{background:rgba(231,76,60,0.1);color:#e74c3c;border-color:rgba(231,76,60,0.25)}
.btn-sm{padding:3px 8px;font-size:0.65rem}
.btn-icon{background:none;border:none;cursor:pointer;color:var(--paper2);font-size:0.85rem;padding:2px 5px;transition:color 0.12s}
.btn-icon:hover{color:var(--gold)}
.dropzone{border:2px dashed var(--border);border-radius:9px;padding:22px;text-align:center;cursor:pointer;transition:all 0.15s;margin-bottom:10px;font-size:0.8rem;color:var(--paper2)}
.dropzone.drag{border-color:var(--gold);background:var(--gold3)}.dropzone:hover{border-color:rgba(201,168,76,0.4);background:var(--glass)}
.imp-item{background:var(--glass);border:1px solid var(--border2);border-radius:8px;padding:8px 10px;margin-bottom:6px}
.imp-row{display:flex;gap:9px;align-items:flex-start}
.imp-thumb{width:56px;height:46px;object-fit:cover;border-radius:5px;flex-shrink:0}
.imp-info{flex:1;min-width:0}.imp-meta{font-size:0.66rem;color:var(--paper2);margin-bottom:3px}
.sighting-item{display:flex;justify-content:space-between;align-items:flex-start;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04)}
.si-sp{font-weight:600;font-size:0.8rem}.si-m{font-size:0.66rem;color:var(--paper2);margin-top:1px}
.si-b{font-size:0.7rem;color:var(--gold2);font-style:italic}
.eb-item{padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.04);display:flex;justify-content:space-between;align-items:center}
.eb-sp{font-weight:600;font-size:0.79rem}.eb-meta{font-size:0.63rem;color:var(--paper2);margin-top:1px}
.eb-badge{font-size:0.58rem;padding:1px 7px;border-radius:6px;font-weight:600}
.eb-rare{background:rgba(231,76,60,0.15);color:#e74c3c;border:1px solid rgba(231,76,60,0.25)}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--ink2);border:1px solid var(--border);border-radius:8px;padding:8px 18px;font-size:0.78rem;color:var(--gold);z-index:999;pointer-events:none;white-space:nowrap;box-shadow:0 4px 20px rgba(0,0,0,0.4)}
.sub-tabs{display:flex;border:1px solid var(--border);border-radius:6px;overflow:hidden;margin-bottom:11px}
.st{flex:1;padding:6px 3px;text-align:center;cursor:pointer;font-size:0.72rem;font-weight:500;color:var(--paper2);background:none;border:none;transition:all 0.17s}
.st.a{background:var(--gold3);color:var(--gold)}.st:hover:not(.a){background:var(--glass2);color:var(--paper)}
::-webkit-scrollbar{width:3px;height:3px}::-webkit-scrollbar-thumb{background:rgba(201,168,76,0.22);border-radius:2px}
.map-wrap{border-radius:9px;overflow:hidden;border:1px solid var(--border)}
#scout-map{width:100%;height:430px}
.empty{text-align:center;padding:22px 14px;color:var(--paper2);font-size:0.78rem}
.empty-i{font-size:1.6rem;margin-bottom:5px}
`;

// ─── BEST-TIME INTELLIGENCE from sightings ────────────────────────────────────
// Given location name + month + sightings array, compute best photo hours
// relative to sunrise/sunset. Returns a string like "Best: 30–90min after sunrise"
const getBestTimeFromSightings = (locName, month, sightings, sunrise, sunset) => {
  const parseTime = str => { if(!str) return null; const [h,m]=(str||"06:00").split(":"); return parseInt(h)+parseInt(m)/60; };
  const srH = parseTime(sunrise) || 6.2;
  const ssH = parseTime(sunset)  || 20.3;

  const relevant = sightings.filter(s => {
    const mMatch = !month || Math.abs((s.month||0) - month) <= 1 || Math.abs((s.month||0) - month) >= 11;
    const lMatch = !locName || (s.location_name||"").toLowerCase().includes(locName.toLowerCase().slice(0,8));
    return mMatch && lMatch && s.date;
  });

  if (relevant.length < 3) return null;

  // Extract hour from notes or time_of_day
  const hours = relevant.map(s => {
    // Try to get hour from notes field (has time embedded)
    const notesMatch = (s.notes||"").match(/\b(\d{1,2}):(\d{2})\b/);
    if (notesMatch) return parseInt(notesMatch[1]) + parseInt(notesMatch[2])/60;
    // Fall back to time_of_day
    const tod = (s.time_of_day||"").toLowerCase();
    if (tod === "dawn") return srH - 0.25;
    if (tod === "morning") return srH + 1.5;
    if (tod === "midday") return 12;
    if (tod === "afternoon") return 15;
    if (tod === "dusk") return ssH - 0.5;
    return null;
  }).filter(h => h !== null);

  if (hours.length < 2) return null;

  // Convert to offsets from sunrise/sunset
  const srOffsets = hours.map(h => h - srH);
  const ssOffsets = hours.map(h => h - ssH);

  // Find cluster: are most photos near sunrise or sunset?
  const nearSunrise = srOffsets.filter(o => o >= -0.5 && o <= 3).length;
  const nearSunset  = ssOffsets.filter(o => o >= -2 && o <= 0.5).length;
  const midday      = hours.filter(h => h >= 10 && h <= 15).length;

  if (nearSunrise >= 2 && nearSunrise >= nearSunset) {
    const avg = srOffsets.filter(o => o >= -0.5 && o <= 3).reduce((a,b)=>a+b,0) / nearSunrise;
    const mins = Math.round(avg * 60);
    if (mins < 0) return `📷 Best: before sunrise (${Math.abs(mins)}min prior)`;
    if (mins < 30) return `📷 Best: at & just after sunrise`;
    if (mins < 90) return `📷 Best: ${mins}min after sunrise`;
    return `📷 Best: morning light (${Math.round(mins/60*10)/10}hr after sunrise)`;
  } else if (nearSunset >= 2 && nearSunset > nearSunrise) {
    const avg = ssOffsets.filter(o => o >= -2 && o <= 0.5).reduce((a,b)=>a+b,0) / nearSunset;
    const mins = Math.round(Math.abs(avg) * 60);
    if (mins < 20) return `📷 Best: at sunset`;
    return `📷 Best: ${mins}min before sunset`;
  } else if (midday > 0) {
    return `📷 Best: midday–afternoon (thermals / behaviour)`;
  }
  return null;
};

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function PhotographyScout() {
  const [mainTab,     setMainTab]    = useState("wildlife");
  const [timeWindow,  setTimeWindow] = useState("now");
  const [dataSubTab,  setDataSubTab] = useState("sightings");
  const [selDate,     setSelDate]    = useState(new Date());
  const [calMonth,    setCalMonth]   = useState(new Date());
  const [selLoc,      setSelLoc]     = useState(null);
  const [locations,   setLocations]  = useState([]);
  const [sightings,   setSightings]  = useState([]);
  const [ebirdData,   setEbirdData]  = useState([]);
  const [ebirdLoading,setEbirdLoading]=useState(false);
  const [ebirdError,  setEbirdError] = useState("");
  const [weather,     setWeather]    = useState(null);
  const [weatherError,setWeatherError]= useState("");
  const [wxRetried,   setWxRetried]   = useState(false);
  const [marine,      setMarine]     = useState(null);
  const [aiText,      setAiText]     = useState("");
  const [aiLoading,   setAiLoading]  = useState(false);
  const [mapLoaded,   setMapLoaded]  = useState(false);
  const [mapInst,     setMapInst]    = useState(null);
  const [tick,        setTick]       = useState(new Date());
  const [addForm,     setAddForm]    = useState({open:false,type:""});
  const [formData,    setFormData]   = useState({});
  const [status,      setStatus]     = useState("");
  const [importItems, setImportItems]= useState([]);
  const [dragOver,    setDragOver]   = useState(false);
  const [seedStatus,  setSeedStatus] = useState("idle");
  const [chatMsgs,    setChatMsgs]   = useState([
    {role:"ai", text:"Hi Matt! Ask me anything about photography on the Mornington Peninsula — species locations, best times, conditions, gear for specific shots, or what's been seen recently nearby."}
  ]);
  const [chatInput,   setChatInput]  = useState("");
  const [chatLoading, setChatLoading]= useState(false);
  const mapRef  = useRef(null);
  const fileRef = useRef(null);
  const chatEndRef = useRef(null);

  useEffect(()=>{ const t=setInterval(()=>setTick(new Date()),1000); return ()=>clearInterval(t); },[]);
  useEffect(()=>{ initApp(); },[]);
  useEffect(()=>{ chatEndRef.current?.scrollIntoView({behavior:"smooth"}); },[chatMsgs]);

  const toast = (msg,ms=3200) => { setStatus(msg); setTimeout(()=>setStatus(""),ms); };

  const initApp = async () => {
    await Promise.all([loadLocations(), loadSightings(), fetchWeather(), fetchMarine()]);
  };

  // ── DATA LOADING ──────────────────────────────────────────────────────────
  const loadLocations = async () => {
    try {
      let locs = await dbGet("scout_locations","order=created_at.asc");
      if(!locs||locs.length===0){ const s=await dbInsert("scout_locations",DEFAULT_LOCATIONS); locs=s||DEFAULT_LOCATIONS; }
      setLocations(locs.map(l=>({...l,distance:haversine(HOME_LAT,HOME_LNG,l.lat,l.lng)})));
    } catch {
      setLocations(DEFAULT_LOCATIONS.map(l=>({...l,id:Math.random().toString(36),distance:haversine(HOME_LAT,HOME_LNG,l.lat,l.lng)})));
    }
  };

  const loadSightings = async () => {
    try { setSightings((await dbGet("scout_sightings","order=created_at.desc&limit=500"))||[]); } catch { setSightings([]); }
  };

  const fetchWeather = async (isRetry=false) => {
    setWeatherError("");
    try {
      // Use Netlify proxy to avoid browser-level network restrictions on open-meteo.com
      const url = `/.netlify/functions/weather?type=forecast`;
      const ctrl = new AbortController();
      const timer = setTimeout(()=>ctrl.abort(), 15000);
      const res = await fetch(url, {signal: ctrl.signal}).finally(()=>clearTimeout(timer));
      if(!res.ok){ setWeatherError(`HTTP ${res.status}`); return; }
      const data = await res.json();
      if(data.error){ setWeatherError(data.reason||"API error"); return; }

      // Patch current block from hourly if any fields missing
      const nowH = new Date().getHours();
      const hIdx = data.hourly?.time
        ? data.hourly.time.findIndex(t=>t&&t.split("T")[1]?.startsWith(String(nowH).padStart(2,"0")))
        : -1;
      const hAt = (arr)=> (hIdx>=0&&arr?.[hIdx]!=null) ? arr[hIdx] : (arr?.[0]??null);
      if(!data.current) data.current = {};
      const cur = data.current;
      if(cur.temperature_2m     ==null) cur.temperature_2m     = hAt(data.hourly?.temperature_2m);
      if(cur.wind_speed_10m     ==null) cur.wind_speed_10m     = hAt(data.hourly?.wind_speed_10m);
      if(cur.wind_direction_10m ==null) cur.wind_direction_10m = hAt(data.hourly?.wind_direction_10m);
      if(cur.cloud_cover        ==null) cur.cloud_cover        = hAt(data.hourly?.cloud_cover);
      if(cur.weather_code       ==null) cur.weather_code       = hAt(data.hourly?.weather_code);
      if(cur.apparent_temperature==null) cur.apparent_temperature = cur.temperature_2m;
      if(cur.precipitation      ==null) cur.precipitation      = 0;
      // legacy format
      if(cur.temperature_2m==null && data.current_weather){
        cur.temperature_2m=data.current_weather.temperature;
        cur.wind_speed_10m=data.current_weather.windspeed;
        cur.wind_direction_10m=data.current_weather.winddirection;
        cur.weather_code=data.current_weather.weathercode;
        cur.apparent_temperature=data.current_weather.temperature;
      }
      console.log("Weather OK temp:",cur.temperature_2m,"wind:",cur.wind_speed_10m,"cloud:",cur.cloud_cover);
      setWeather(data);
      setWeatherError("");
    } catch(e){
      const msg = e.message||"";
      const friendlyMsg = (msg.includes("Failed to fetch")||msg.includes("NetworkError")||msg.toLowerCase().includes("fetch"))
        ? "Network blocked — will work on Netlify"
        : msg||"Network error";
      console.warn("Weather fetch error:", msg);
      setWeatherError(friendlyMsg);
      if(!isRetry){ setTimeout(()=>{ setWxRetried(true); fetchWeather(true); }, 4000); }
    }
  };

  const fetchMarine = async () => {
    try {
      const url = `/.netlify/functions/weather?type=marine`;
      setMarine(await(await fetch(url)).json());
    } catch {}
  };

  const fetchEbird = async () => {
    setEbirdLoading(true); setEbirdError("");
    try {
      const headers={"X-eBirdApiToken":EBIRD_KEY};
      const url=`https://api.ebird.org/v2/data/obs/geo/recent/notable?lat=${HOME_LAT}&lng=${HOME_LNG}&dist=${EBIRD_RADIUS}&back=14&detail=full&key=${EBIRD_KEY}`;
      const res=await fetch(url,{headers});
      if(res.ok){ const d=await res.json(); if(Array.isArray(d)&&d.length>0){setEbirdData(d.slice(0,30));setEbirdLoading(false);return;} }
      const url2=`https://api.ebird.org/v2/data/obs/geo/recent?lat=${HOME_LAT}&lng=${HOME_LNG}&dist=${EBIRD_RADIUS}&back=7&maxResults=50&key=${EBIRD_KEY}`;
      const res2=await fetch(url2,{headers});
      if(res2.ok){ const d2=await res2.json(); if(Array.isArray(d2)){setEbirdData(d2.slice(0,30));}else{setEbirdError(`Unexpected eBird response`);} }
      else setEbirdError(`eBird error ${res2.status} — CORS likely. Works once deployed to Netlify.`);
    } catch(e){ setEbirdError(`eBird blocked (CORS). Works once deployed.`); }
    setEbirdLoading(false);
  };

  // ── WINDOW HOUR ───────────────────────────────────────────────────────────
  const getSunTimes = useCallback((dayOffset=0) => {
    const idx = Math.min(dayOffset, (weather?.daily?.sunrise?.length||1)-1);
    const sr = weather?.daily?.sunrise?.[idx]?.split("T")[1]?.slice(0,5) || "06:10";
    const ss = weather?.daily?.sunset?.[idx]?.split("T")[1]?.slice(0,5)  || "20:20";
    return { sunrise: sr, sunset: ss };
  }, [weather]);

  const getDayOffset = useCallback(() => {
    const today = new Date(); today.setHours(0,0,0,0);
    const sel   = new Date(selDate); sel.setHours(0,0,0,0);
    return Math.max(0, Math.min(6, Math.round((sel-today)/(1000*60*60*24))));
  }, [selDate]);

  const windowHour = useCallback(() => {
    const { sunrise, sunset } = getSunTimes(getDayOffset());
    const sr = parseInt(sunrise.split(":")[0]);
    const ss = parseInt(sunset.split(":")[0]);
    if(timeWindow==="sunrise") return sr;
    if(timeWindow==="sunset")  return ss;
    if(timeWindow==="night")   return ss+2;
    return new Date().getHours();
  }, [timeWindow, getSunTimes, getDayOffset]);

  // ── AI RECOMMENDATIONS ────────────────────────────────────────────────────
  const runAnalysis = useCallback(async (tab, win, date, locs, wx, mar, userSightings, ebird, focusLoc) => {
    setAiLoading(true); setAiText("");
    const month = date.getMonth()+1;
    const dayOff = Math.max(0,Math.min(6,Math.round((new Date(date).setHours(0,0,0,0)-new Date().setHours(0,0,0,0))/(86400000))));
    const { sunrise, sunset } = (() => {
      const idx=Math.min(dayOff,(wx?.daily?.sunrise?.length||1)-1);
      return { sunrise: wx?.daily?.sunrise?.[idx]?.split("T")[1]?.slice(0,5)||"06:10", sunset: wx?.daily?.sunset?.[idx]?.split("T")[1]?.slice(0,5)||"20:20" };
    })();
    const { season, behaviour } = seasonal(month);
    const moon = getMoonData(date);
    const wxC  = wx?.current;
    const waveH= mar?.current?.wave_height;
    const swellH=mar?.current?.swell_wave_height;
    const wavePer=mar?.current?.wave_period;
    const wc   = waterCondition(waveH, wavePer, wxC?.wind_speed_10m);
    const astro= getAstroRating(moon, wxC?.cloud_cover);
    const winHour = win==="sunrise"?parseInt(sunrise):win==="sunset"?parseInt(sunset):win==="night"?parseInt(sunset)+2:new Date().getHours();

    const topLocs = focusLoc ? [focusLoc] : locs
      .filter(l => tab==="wildlife"
        ? (l.tags||[]).some(t=>["raptors","shorebirds","waders","parrots","small-birds","seabirds","waterbirds","eagles","forest","herons","wetlands"].includes(t))
        : (l.tags||[]).some(t=>["landscape","sunrise","sunset","golden-hour","coastal","surf"].includes(t)))
      .map(l=>({...l,...rateLocation(l,winHour,tab,wx,mar,userSightings,month)}))
      .sort((a,b)=>b.score-a.score).slice(0,4);

    const recentSightings = userSightings.filter(s=>Math.abs((s.month||0)-month)<=1).slice(0,10);
    const locSightings = focusLoc ? userSightings.filter(s=>(s.location_name||"").toLowerCase().includes((focusLoc.name||"").toLowerCase().slice(0,8))).slice(0,8) : [];
    const ebirdStr = ebird.slice(0,12).map(e=>`${e.comName} at ${e.locName} (${e.obsDt})`).join("\n")||"eBird not loaded (CORS — works when hosted)";

    const windowMap = {
      now:     `RIGHT NOW (${new Date().getHours()}:${String(new Date().getMinutes()).padStart(2,"0")} local time)`,
      sunrise: `SUNRISE WINDOW (${sunrise}, golden hour ${addMins(sunrise,-20)} – ${addMins(sunrise,90)})`,
      sunset:  `SUNSET WINDOW (${sunset}, golden hour ${addMins(sunset,-90)} – ${addMins(sunset,20)})`,
      night:   `NIGHT (after ${sunset}, moon: ${moon.name} ${moon.illumination}% lit, rises ${moon.rise})`,
    };

    const prompt = tab === "wildlife" ? `You are Matt Sheumack's expert wildlife photography advisor for the Mornington Peninsula, Victoria, Australia. Matt is a professional wildlife photographer who specialises in raptors (Wedge-tailed Eagle, Peregrine Falcon, Black-shouldered Kite), fairy-wrens, parrots, and shorebirds.

DATE: ${date.toLocaleDateString("en-AU",{weekday:"long",day:"numeric",month:"long"})} | SEASON: ${season}
TIME WINDOW: ${windowMap[win]}
Sunrise: ${sunrise} | Sunset: ${sunset}
Temp: ${wxC?.temperature_2m||"?"}°C (feels ${wxC?.apparent_temperature||"?"}°C) | ${wxIcon(wxC?.weather_code)} ${wxC?.cloud_cover||"?"}% cloud
Wind: ${wxC?.wind_speed_10m||"?"}km/h ${windDirStr(wxC?.wind_direction_10m)}
Moon: ${moon.name} · ${moon.illumination}% lit

${focusLoc ? `SELECTED LOCATION: ${focusLoc.name} (tags: ${(focusLoc.tags||[]).join(", ")})
Location notes: ${focusLoc.notes||""}

MATT'S SIGHTINGS AT THIS LOCATION:
${locSightings.length>0?locSightings.map(s=>`- ${s.species||"?"} (${s.date||"?"}, ${s.time_of_day||""}, ${s.behaviour||""})`).join("\n"):"No recorded sightings at this location yet."}
` : `TOP LOCATIONS FOR THIS WINDOW:
${topLocs.map(l=>`- ${l.name} [${(l.tags||[]).join(",")}]: ${l.notes||""}`).join("\n")}
`}
SEASONAL CONTEXT: ${behaviour}

MATT'S RECENT SIGHTINGS (±1 month, this season):
${recentSightings.length>0?recentSightings.map(s=>`- ${s.species} at ${s.location_name||"?"} (${s.date||"?"}, ${s.time_of_day||""})`).join("\n"):"None yet for this season."}

eBIRD NEARBY (last 14 days):
${ebirdStr}

Generate rich wildlife photography recommendations. Use EXACTLY these HTML headings:

<h4>🦅 Species to Target</h4>
<ul>
<li><strong>Species Name</strong> — one sentence on behaviour + exact spot within the location. Add 🥚 breeding / 🐣 fledging / 💛 courtship if relevant this month.</li>
</ul>
List 3-5 species this way. Each gets its own <li>. No camera advice.

<h4>📍 Where Exactly</h4>
<ul>
<li>Micro-spot 1 within location</li>
<li>Micro-spot 2</li>
</ul>

<h4>📡 Recent Intel</h4>
<ul>
<li><strong>Notable species</strong> — one line from Matt's sightings or eBird worth acting on today</li>
</ul>
Max 3 items. Punchy — this is read on-the-go.`

    : `You are an expert landscape photography advisor for the Mornington Peninsula, Victoria, Australia.

DATE: ${date.toLocaleDateString("en-AU",{weekday:"long",day:"numeric",month:"long"})} | SEASON: ${season}
TIME WINDOW: ${windowMap[win]}
Sunrise: ${sunrise} | Sunset: ${sunset}

WEATHER CONDITIONS:
Temp: ${wxC?.temperature_2m||"?"}°C | Cloud: ${wxC?.cloud_cover||"?"}% | ${wxIcon(wxC?.weather_code)}
Wind: ${wxC?.wind_speed_10m||"?"}km/h ${windDirStr(wxC?.wind_direction_10m)}
Visibility: ${wx?.hourly?.visibility?.[new Date().getHours()]||"?"}m
Precipitation: ${wxC?.precipitation||0}mm

MARINE CONDITIONS:
Swell: ${swellH||"?"}m | Waves: ${waveH||"?"}m | Period: ${wavePer||"?"}s | Condition: ${wc.label}

MOON & ASTRO:
${moon.name} · ${moon.illumination}% lit · Rises ${moon.rise} · Sets ${moon.set}
${win==="night"?`Astro rating: ${astro.label} | Milky Way (Feb-May): ${moon.mwSeason?"IN SEASON":"out of season"}`:""}

${focusLoc ? `SELECTED LOCATION: ${focusLoc.name}
Tags: ${(focusLoc.tags||[]).join(", ")} | Notes: ${focusLoc.notes||""}` : `TOP LANDSCAPE LOCATIONS:
${topLocs.map(l=>`- ${l.name} [${(l.tags||[]).join(",")}]: ${l.notes||""}`).join("\n")}`}

Generate landscape photography recommendations. Use EXACTLY these HTML headings:

<h4>🌅 Light & Conditions Assessment</h4>
[Honest assessment of today's light quality. Cloud type matters — thin high cloud = soft diffuse, cumulus = dramatic, overcast = flat. Wind effect on long exposures. Any atmospheric haze, smoke, or humidity that could enhance or degrade shots.]

<h4>📍 Best Location & Composition</h4>
[Specific location recommendation with exact composition advice — foreground elements, focal point, orientation. If coastal: wave timing, position relative to sun angle.]

<h4>🌊 Water & Atmosphere</h4>
[Current water conditions and what they mean photographically. Long exposure potential. Tide effect. Any aurora probability (geomagnetic conditions). Fog, mist, or smoke potential.]

<h4>📍 Best Spot & Timing</h4>
<ul>
<li>Exact position + timing</li>
</ul>

2 sentences per section max. Use <ul><li> for any lists. Honest about poor conditions. No camera settings.`;

    try {
      const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json","x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},body:JSON.stringify({model:MODEL,max_tokens:1200,messages:[{role:"user",content:prompt}]})});
      const d=await res.json();
      setAiText(d.content?.[0]?.text||"Unable to generate analysis.");
    } catch { setAiText("AI analysis unavailable — check API key."); }
    setAiLoading(false);
  }, []);

  useEffect(()=>{
    if(locations.length>0&&weather) runAnalysis(mainTab,timeWindow,selDate,locations,weather,marine,sightings,ebirdData,selLoc);
  },[mainTab,timeWindow,selDate.toDateString(),selLoc?.name,locations.length,!!weather,!!marine,ebirdData.length]);

  // ── CHATBOT ───────────────────────────────────────────────────────────────
  const sendChat = async (msg) => {
    if(!msg.trim()||chatLoading) return;
    const userMsg = msg.trim();
    setChatInput("");
    setChatMsgs(p=>[...p,{role:"user",text:userMsg}]);
    setChatLoading(true);

    const month = new Date().getMonth()+1;
    const { sunrise, sunset } = getSunTimes(0);
    const wx = weather?.current;
    const recentSp = [...new Set(sightings.slice(0,50).map(s=>s.species).filter(Boolean))].slice(0,20);
    const topLocs = locations.slice(0,12).map(l=>`${l.name} [${(l.tags||[]).join(",")}]`).join(", ");
    const myHistory = sightings.slice(0,30).map(s=>`${s.species} at ${s.location_name||"?"} (${s.date||"?"}, ${s.time_of_day||""})`).join("\n");
    const ebirdStr = ebirdData.slice(0,10).map(e=>`${e.comName} at ${e.locName}`).join(", ")||"Not loaded";

    const systemPrompt = `You are Matt Sheumack's personal photography intelligence assistant for the Mornington Peninsula, Victoria, Australia. Matt is a professional wildlife photographer based at Boundary Road, Dromana, specialising in raptors, fairy-wrens, parrots, and coastal wildlife.

CURRENT CONDITIONS (${new Date().toLocaleDateString("en-AU")}):
Season: ${seasonal(month).season} | Temp: ${wx?.temperature_2m||"?"}°C | Wind: ${wx?.wind_speed_10m||"?"}km/h ${windDirStr(wx?.wind_direction_10m)}
Sunrise: ${sunrise} | Sunset: ${sunset} | Moon: ${getMoonData(new Date()).name} ${getMoonData(new Date()).illumination}% lit
Swell: ${marine?.current?.wave_height||"?"}m | ${seasonal(month).behaviour}

MATT'S LOCATIONS: ${topLocs}

MATT'S RECENT SIGHTINGS:
${myHistory}

RECENT eBIRD NEARBY: ${ebirdStr}

Answer Matt's questions with specific, actionable advice tailored to his Peninsula. Reference his actual sightings data where relevant. Be direct and concise — he's a professional, skip the basics. Use HTML for structure if helpful (h4, p tags). Keep responses under 300 words.`;

    try {
      const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json","x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},body:JSON.stringify({model:MODEL,max_tokens:600,system:systemPrompt,messages:[{role:"user",content:userMsg}]})});
      const d=await res.json();
      setChatMsgs(p=>[...p,{role:"ai",text:d.content?.[0]?.text||"No response."}]);
    } catch { setChatMsgs(p=>[...p,{role:"ai",text:"Error connecting to AI."}]); }
    setChatLoading(false);
  };

  // ── MAPS ──────────────────────────────────────────────────────────────────
  useEffect(()=>{ if(mainTab==="map"){if(window.google){if(!mapInst)initMap();}else loadGMaps();} },[mainTab]);
  useEffect(()=>{ if(mapInst&&locations.length>0)updateMarkers(); },[mapInst,locations,timeWindow,mainTab]);

  const loadGMaps=()=>{ const s=document.createElement("script"); s.src=`https://maps.googleapis.com/maps/api/js?key=${GMAPS_KEY}`; s.onload=()=>initMap(); document.head.appendChild(s); };
  const initMap=()=>{
    if(!mapRef.current)return;
    const map=new window.google.maps.Map(mapRef.current,{center:{lat:HOME_LAT,lng:HOME_LNG},zoom:11,styles:[{elementType:"geometry",stylers:[{color:"#07070f"}]},{elementType:"labels.text.stroke",stylers:[{color:"#07070f"}]},{elementType:"labels.text.fill",stylers:[{color:"#c9a84c"}]},{featureType:"water",elementType:"geometry",stylers:[{color:"#050d18"}]},{featureType:"road",elementType:"geometry",stylers:[{color:"#14142a"}]},{featureType:"road.arterial",elementType:"geometry",stylers:[{color:"#1e1e38"}]},{featureType:"poi.park",elementType:"geometry",stylers:[{color:"#081408"}]},{featureType:"administrative",elementType:"geometry.stroke",stylers:[{color:"#252550"}]}]});
    setMapInst(map); setMapLoaded(true);
  };
  const updateMarkers=()=>{
    const hour=windowHour();
    locations.forEach(loc=>{
      const {rating}=rateLocation(loc,hour,mainTab==="map"?"wildlife":mainTab,weather,marine,sightings,new Date().getMonth()+1);
      const color=rating==="green"?"#2ecc71":rating==="amber"?"#f39c12":"#e74c3c";
      new window.google.maps.Marker({position:{lat:loc.lat,lng:loc.lng},map:mapInst,title:loc.name,icon:{path:window.google.maps.SymbolPath.CIRCLE,scale:8,fillColor:color,fillOpacity:0.9,strokeColor:"#fff",strokeWeight:1.5}}).addListener("click",()=>setSelLoc(loc));
    });
    new window.google.maps.Marker({position:{lat:HOME_LAT,lng:HOME_LNG},map:mapInst,title:"Home — Boundary Road",icon:{path:window.google.maps.SymbolPath.CIRCLE,scale:10,fillColor:"#c9a84c",fillOpacity:1,strokeColor:"#fff",strokeWeight:2}});
  };

  // ── SIGHTING FORM ─────────────────────────────────────────────────────────
  const saveSighting = async () => {
    if(!formData.species)return;
    try {
      await dbInsert("scout_sightings",[{...formData,month:formData.date?new Date(formData.date).getMonth()+1:new Date().getMonth()+1,location_name:formData.location_name||selLoc?.name||""}]);
      await loadSightings(); setFormData({}); setAddForm({open:false}); toast("Sighting saved ✓");
    } catch { toast("Error saving sighting"); }
  };
  const saveLocation = async () => {
    if(!formData.name||!formData.lat||!formData.lng)return;
    try {
      await dbInsert("scout_locations",[{...formData,lat:parseFloat(formData.lat),lng:parseFloat(formData.lng),tags:formData.tags?formData.tags.split(",").map(t=>t.trim()):[]}]);
      await loadLocations(); setFormData({}); setAddForm({open:false}); toast("Location saved ✓");
    } catch { toast("Error saving location"); }
  };

  // ── XMP BULK IMPORT ───────────────────────────────────────────────────────
  const parseXmp = (xml) => {
    const get=(tag)=>{const m=xml.match(new RegExp(`${tag}="([^"]+)"`));return m?m[1]:null;};
    const raw=get("exif:DateTimeOriginal")||get("xmp:CreateDate")||"";
    const parts=raw.split("T"); const date=parts[0]||null; const time=parts[1]?.slice(0,5)||null;
    const month=date?parseInt(date.split("-")[1]):null;
    const h=time?parseInt(time.split(":")[0]):null;
    const tod=h==null?null:h<7?"Dawn":h<12?"Morning":h<15?"Midday":h<18?"Afternoon":"Dusk";
    const isoM=xml.match(/<exif:ISOSpeedRatings>.*?<rdf:li>(\d+)<\/rdf:li>/s);
    const subjM=xml.match(/<dc:subject>(.*?)<\/dc:subject>/s);
    const kws=subjM?[...subjM[1].matchAll(/<rdf:li>([^<]+)<\/rdf:li>/g)].map(m=>m[1].trim()):[];
    const JUNK=new Set(["bird","birds","wildlife","matt sheumack photography","mornington peninsula","victoria","australia","avian","animal","outdoors","fauna","ornithology","sky","aerial","aurora","atmospheric","action","natural","water","coastal","stock photo","ocean","flight","flying","pickofbatch","passed","cull","duplicateofbatch","sea","dawn","dusk","sunrise","sunset","rye","dromana","safety beach","portrait","macro","bokeh","landscape","beach","wetland","seascape","lake","cliff","garden","park","creek","coast","island"]);
    const LOC_WORDS=["reserve","beach","road","bay","park","creek","cape","mount","island","wetland","foreshore","lake","blowhole","quarry","paddock","cliff","estate","garden","ridge","gardens","wetlands","national park","harbour","port","inlet"];
    let species=null,location=null;
    for(const kw of kws){const kl=kw.toLowerCase();if(kl in JUNK||JUNK.has(kl))continue;if(LOC_WORDS.some(w=>kl.includes(w))){if(!location)location=kw;}else if(!species)species=kw;}
    const parseFrac=s=>{if(!s)return null;if(s.includes("/")){ const[a,b]=s.split("/");return parseFloat(a)/parseFloat(b);}return parseFloat(s);};
    const fn=get("exif:FNumber"); const fl=get("exif:FocalLengthIn35mmFilm");
    return {date,time,month,time_of_day:tod,species,location,camera:get("tiff:Model"),lens:get("aux:Lens"),focal_length:fl?`${fl}mm eq`:null,shutter:get("exif:ExposureTime"),aperture:fn?`f/${parseFrac(fn).toFixed(1)}`:null,iso:isoM?isoM[1]:null,rating:get("xmp:Rating")};
  };

  const processFiles = async (files) => {
    const fileArr=Array.from(files);
    const jpgs=fileArr.filter(f=>f.name.match(/\.(jpg|jpeg)$/i));
    const xmps=fileArr.filter(f=>f.name.match(/\.xmp$/i));
    const xmpMap={}; for(const x of xmps){const base=x.name.replace(/\.xmp$/i,""); xmpMap[base]=x;}
    const stripBase=n=>n.replace(/\.(jpg|jpeg)$/i,"").replace(/-(Enhanced-NR|Enhanced|NR|Edit|edit).*$/,"").replace(/-\d+$/,"");
    const items=jpgs.map(f=>({id:Math.random().toString(36).slice(2),file:f,status:"pending",species:null,location:null,xmpData:null,thumb:URL.createObjectURL(f)}));
    setImportItems(prev=>[...prev,...items]);
    for(let i=0;i<items.length;i+=4){
      const batch=items.slice(i,i+4);
      await Promise.all(batch.map(async item=>{
        try{
          const base=stripBase(item.file.name);
          const xmpFile=xmpMap[base]||xmpMap[item.file.name.replace(/\.(jpg|jpeg)$/i,"")];
          let xmpData=null;
          if(xmpFile){const xml=await xmpFile.text();xmpData=parseXmp(xml);item.xmpData=xmpData;}
          if(xmpData?.species){
            setImportItems(p=>p.map(it=>it.id===item.id?{...it,status:"done",...xmpData,confidence:"xmp"}:it));
          } else {
            setImportItems(p=>p.map(it=>it.id===item.id?{...it,status:"analyzing"}:it));
            const b64=await new Promise(res=>{const r=new FileReader();r.onload=()=>res(r.result.split(",")[1]);r.readAsDataURL(item.file);});
            const resp=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json","x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},body:JSON.stringify({model:MODEL,max_tokens:200,messages:[{role:"user",content:[{type:"image",source:{type:"base64",media_type:"image/jpeg",data:b64}},{type:"text",text:"Identify the species in this Australian wildlife photo. Reply with ONLY: species name | behaviour (1-3 words) | confidence (high/medium/low). Example: 'Wedge-tailed Eagle | soaring | high'. If no wildlife, say 'Unknown | none | low'."}]}]})});
            const d=await resp.json(); const txt=d.content?.[0]?.text||"";
            const[sp,beh,conf]=txt.split("|").map(s=>s.trim());
            setImportItems(p=>p.map(it=>it.id===item.id?{...it,status:"done",species:sp||"Unknown",behaviour:beh||"",confidence:conf||"low",...(xmpData||{})}:it));
          }
        }catch{setImportItems(p=>p.map(it=>it.id===item.id?{...it,status:"error"}:it));}
      }));
    }
    toast(`✓ ${jpgs.length} photos processed`);
  };

  const saveAllReady = async () => {
    const ready=importItems.filter(it=>it.status==="done"&&it.species&&it.species!=="Unknown");
    if(!ready.length){toast("No confirmed items to save");return;}
    try {
      await dbInsert("scout_sightings",ready.map(item=>({species:item.species,location_name:item.location||"",count:1,behaviour:item.behaviour||"",date:item.date,time_of_day:item.time_of_day||"",month:item.month,notes:[item.lens,item.focal_length,item.shutter&&`${item.shutter}s`,item.aperture,item.iso&&`ISO${item.iso}`,item.rating&&item.rating!=="0"?`★${item.rating}`:null].filter(Boolean).join(" · ")})));
      setImportItems(p=>p.filter(it=>!ready.find(r=>r.id===it.id)));
      await loadSightings();
      toast(`✓ ${ready.length} sightings saved`);
    } catch { toast("Error saving batch"); }
  };

  // ── XMP ARCHIVE SEED ──────────────────────────────────────────────────────
  const seedXmpData = async () => {
    setSeedStatus("running");
    toast("Seeding 666 sightings from XMP archive…");
    try {
      const existingLocs=await dbGet("scout_locations","select=name");
      const existingNames=new Set((existingLocs||[]).map(l=>l.name.toLowerCase()));
      const toCreate=NEW_LOCATIONS_FROM_XMP.filter(l=>!existingNames.has(l.name.toLowerCase()));
      if(toCreate.length>0){await dbInsert("scout_locations",toCreate);toast(`✓ Created ${toCreate.length} new locations`);}
      const check=await dbGet("scout_sightings","select=id&notes=like.*DSC*&limit=5");
      if(check&&check.length>0){toast("XMP data already seeded");setSeedStatus("done");return;}
      const CHUNK=100; let inserted=0;
      for(let i=0;i<XMP_SIGHTINGS.length;i+=CHUNK){
        await dbInsert("scout_sightings",XMP_SIGHTINGS.slice(i,i+CHUNK));
        inserted+=Math.min(CHUNK,XMP_SIGHTINGS.length-i);
        setSeedStatus(`running:${inserted}`);
      }
      await loadSightings(); setSeedStatus("done"); toast(`✓ Seeded ${inserted} sightings`);
    } catch(e){ console.error(e); setSeedStatus("error"); toast("Seed failed"); }
  };

  // ─── COMPONENTS ──────────────────────────────────────────────────────────────

  const CondBar = () => {
    // Build wx from current block + hourly fallback if any fields are missing
    const raw = weather?.current || {};
    const nowH = new Date().getHours();
    const hIdx = weather?.hourly?.time
      ? weather.hourly.time.findIndex(t=>(t||"").split("T")[1]?.startsWith(String(nowH).padStart(2,"0")))
      : -1;
    const hAt = (arr) => hIdx>=0 && arr?.[hIdx]!=null ? arr[hIdx] : arr?.[0] ?? null;
    const wx = {
      temperature_2m:     raw.temperature_2m     ?? hAt(weather?.hourly?.temperature_2m),
      wind_speed_10m:     raw.wind_speed_10m     ?? hAt(weather?.hourly?.wind_speed_10m),
      wind_direction_10m: raw.wind_direction_10m ?? hAt(weather?.hourly?.wind_direction_10m),
      cloud_cover:        raw.cloud_cover        ?? hAt(weather?.hourly?.cloud_cover),
      weather_code:       raw.weather_code       ?? hAt(weather?.hourly?.weather_code),
      apparent_temperature: raw.apparent_temperature ?? raw.temperature_2m ?? hAt(weather?.hourly?.temperature_2m),
      precipitation:      raw.precipitation      ?? 0,
    };
    const moon=getMoonData(selDate);
    const {sunrise,sunset}=getSunTimes(getDayOffset());
    const waveH=marine?.current?.wave_height;
    const swellH=marine?.current?.swell_wave_height;
    const wavePer=marine?.current?.wave_period;
    const wc=waterCondition(waveH,wavePer,wx?.wind_speed_10m);
    const loaded = weather!=null && wx.temperature_2m!=null;
    const cloudLabel=wx?.cloud_cover==null?"—":wx.cloud_cover<20?"Clear":wx.cloud_cover<50?"Part. cloudy":wx.cloud_cover<80?"Mostly cloudy":"Overcast";
    return (
      <div className="cond-bar">
        <div className="cond-inner">
          {!loaded ? (
            <div className="cb" style={{minWidth:260}}>
              <span className="cb-lbl">Weather</span>
              <span className="cb-val" style={{fontSize:"0.65rem",color:weatherError?"var(--red)":"var(--amber)",lineHeight:1.3}}>
                {weatherError ? `⚠️ ${weatherError}` : weather===null ? "⏳ Fetching…" : "⚠️ Partial data"}
              </span>
              {weatherError && <span className="cb-sub" style={{fontSize:"0.55rem",color:"var(--paper2)"}}>Check network · open-meteo.com</span>}
              <button className="btn-icon" style={{marginTop:3,fontSize:"0.6rem",padding:"2px 6px"}} onClick={()=>{fetchWeather(true);fetchMarine();}}>↻ Retry now</button>
            </div>
          ) : <>
            <div className="cb"><span className="cb-lbl">Now</span><span className="cb-val" style={{fontSize:"1.05rem"}}>{wxIcon(wx.weather_code)}</span><span className="cb-sub">{wx.temperature_2m}°C</span></div>
            <div className="cb"><span className="cb-lbl">Feels</span><span className="cb-val">{wx.apparent_temperature!=null?`${Math.round(wx.apparent_temperature)}°C`:"—"}</span><span className="cb-sub">apparent</span></div>
            <div className="cb"><span className="cb-lbl">Wind</span><span className="cb-val sky">{wx.wind_speed_10m!=null?`${Math.round(wx.wind_speed_10m)}`:"—"}<small style={{fontSize:"0.6rem"}}> km/h</small></span><span className="cb-sub">{windDirStr(wx.wind_direction_10m)}</span></div>
            <div className="cb"><span className="cb-lbl">Cloud</span><span className="cb-val">{wx.cloud_cover!=null?`${wx.cloud_cover}%`:"—"}</span><span className="cb-sub">{cloudLabel}</span></div>
            {wx.precipitation>0&&<div className="cb"><span className="cb-lbl">Rain</span><span className="cb-val sky">{wx.precipitation}mm</span><span className="cb-sub">current</span></div>}
          </>}
          <div className="cb"><span className="cb-lbl">🌅 Sunrise</span><span className="cb-val gold">{sunrise||"—"}</span><span className="cb-sub">golden ±30min</span></div>
          <div className="cb"><span className="cb-lbl">🌇 Sunset</span><span className="cb-val gold">{sunset||"—"}</span><span className="cb-sub">golden −30min</span></div>
          <div className="cb"><span className="cb-lbl">Moon</span><span className="cb-val" style={{fontSize:"1.05rem"}}>{moon.icon}</span><span className="cb-sub">{moon.name}</span></div>
          <div className="cb"><span className="cb-lbl">🌕 Rise/Set</span><span className="cb-val gold" style={{fontSize:"0.82rem"}}>{moon.rise} / {moon.set}</span><span className="cb-sub">{moon.illumination}% lit</span></div>
          {waveH&&<><div className="cb"><span className="cb-lbl">Swell</span><span className="cb-val sky">{swellH||waveH}m</span><span className="cb-sub">{wavePer?`${wavePer}s period`:"—"}</span></div>
          <div className="cb"><span className="cb-val" style={{color:wc.color}}>{wc.label}</span><span className="cb-sub">{waveH}m ht</span></div></>}
        </div>
      </div>
    );
  };

  const TimeWindowTabs = () => {
    const {sunrise,sunset}=getSunTimes(getDayOffset());
    const now=new Date();
    const nowStr=`${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
    const windows=[
      {id:"now",     icon:"⚡", name:"Right Now",  time:nowStr,                                            color:"#2ecc71"},
      {id:"sunrise", icon:"🌅", name:"Sunrise",    time:`${addMins(sunrise,-20)}–${addMins(sunrise,90)}`, color:"#ff8c42"},
      {id:"sunset",  icon:"🌇", name:"Sunset",     time:`${addMins(sunset,-90)}–${addMins(sunset,20)}`,  color:"#9b6fc4"},
      {id:"night",   icon:"🌙", name:"Night",      time:`After ${sunset}`,                               color:"#4a90d9"},
    ];
    return (
      <div className="tw-tabs">
        {windows.map(w=>(
          <div key={w.id} className={`tw-tab${timeWindow===w.id?" active":""}`}
            style={{color:timeWindow===w.id?w.color:"var(--paper2)",borderColor:timeWindow===w.id?w.color:"var(--border2)"}}
            onClick={()=>setTimeWindow(w.id)}>
            <span className="tw-icon">{w.icon}</span>
            <span className="tw-name" style={{color:timeWindow===w.id?w.color:"var(--paper2)"}}>{w.name}</span>
            <span className="tw-time">{w.time}</span>
          </div>
        ))}
      </div>
    );
  };

  const ForecastStrip = () => {
    if(!weather?.daily) return null;
    return (
      <div className="fs">
        {[0,1,2,3,4].map(i=>{
          const d=new Date(); d.setDate(d.getDate()+i);
          const moon=getMoonData(d);
          const code=weather.daily.weather_code_dominant?.[i];
          const tmax=weather.daily.temperature_2m_max?.[i];
          const tmin=weather.daily.temperature_2m_min?.[i];
          const rain=weather.daily.precipitation_sum?.[i];
          const isSel=d.toDateString()===selDate.toDateString();
          return (
            <div key={i} className={`fd${isSel?" sel":""}`} onClick={()=>setSelDate(new Date(d))}>
              <div className="fd-n">{i===0?"Today":d.toLocaleDateString("en-AU",{weekday:"short"})}</div>
              <div className="fd-w">{wxIcon(code)}</div>
              <div className={`fd-m${moon.isFullMoon?" full":""}`}>{moon.icon}</div>
              <div className="fd-t">{tmax!=null?`${Math.round(tmax)}°`:"—"}<span style={{color:"var(--paper2)",fontWeight:400}}>/{tmin!=null?`${Math.round(tmin)}°`:"—"}</span></div>
              {rain>0.5&&<div className="fd-r">{rain.toFixed(1)}mm</div>}
            </div>
          );
        })}
      </div>
    );
  };

  const CalView = () => {
    const year=calMonth.getFullYear(), mon=calMonth.getMonth();
    const firstDay=new Date(year,mon,1).getDay();
    const daysInMon=new Date(year,mon+1,0).getDate();
    const today=new Date(); today.setHours(0,0,0,0);
    const dayOff=(d)=>{const dt=new Date(year,mon,d);dt.setHours(0,0,0,0);return Math.max(0,Math.min(6,Math.round((dt-today)/86400000)));};
    const getWxForDay=(d)=>{
      const off=dayOff(d);
      if(off<0||off>6||!weather?.daily)return null;
      return{code:weather.daily.weather_code_dominant?.[off],tmax:weather.daily.temperature_2m_max?.[off]};
    };
    return (
      <div>
        <div className="cal-nav">
          <button className="btn-icon" onClick={()=>setCalMonth(new Date(year,mon-1,1))}>◀</button>
          <span className="cal-mn">{calMonth.toLocaleDateString("en-AU",{month:"long",year:"numeric"})}</span>
          <button className="btn-icon" onClick={()=>setCalMonth(new Date(year,mon+1,1))}>▶</button>
        </div>
        <div className="cg">
          {["S","M","T","W","T","F","S"].map((d,i)=><div key={i} className="cdh">{d}</div>)}
          {Array(firstDay===0?6:firstDay-1).fill(null).map((_,i)=><div key={"e"+i}/>)}
          {Array(daysInMon).fill(null).map((_,i)=>{
            const day=i+1;
            const dt=new Date(year,mon,day); dt.setHours(0,0,0,0);
            const isToday=dt.getTime()===today.getTime();
            const isSel=dt.getTime()===new Date(selDate).setHours(0,0,0,0);
            const moon=getMoonData(dt);
            const wx=getWxForDay(day);
            return (
              <div key={day} className={`cd${isToday?" today":""}${isSel?" sel":""}`}
                onClick={()=>setSelDate(new Date(year,mon,day))}
                title={`${moon.name} · ${moon.illumination}% lit`}>
                <span style={{color:isSel?"var(--gold)":isToday?"var(--gold2)":"var(--paper)"}}>{day}</span>
                <div className="cd-icons">
                  <span className={`cd-moon${moon.isFullMoon?" full":""}`}
                    style={{opacity:moon.isFullMoon?1:moon.isMajorPhase?0.8:0.5,fontSize:moon.isFullMoon?"0.9rem":"0.65rem"}}>
                    {moon.icon}
                  </span>
                  {wx&&<span className="cd-wx">{wxIcon(wx.code)}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const LocList = ({filter}) => {
    const hour=windowHour();
    const month=selDate.getMonth()+1;
    const {sunrise,sunset}=getSunTimes(getDayOffset());
    const filtered=locations.filter(l=>{
      if(filter==="wildlife")return(l.tags||[]).some(t=>["raptors","shorebirds","waders","parrots","small-birds","seabirds","waterbirds","eagles","forest","herons","wetlands"].includes(t));
      if(filter==="landscape")return(l.tags||[]).some(t=>["landscape","sunrise","sunset","golden-hour","coastal","surf","seabirds"].includes(t));
      return true;
    }).map(l=>({...l,...rateLocation(l,hour,filter==="both"?"wildlife":filter,weather,marine,sightings,month)}))
      .sort((a,b)=>b.score-a.score||a.distance-b.distance);

    return (
      <div>
        {filtered.map((loc,idx)=>{
          const bestTime=getBestTimeFromSightings(loc.name,month,sightings,sunrise,sunset);
          const whyGood=loc.reasons&&loc.reasons.length>0?loc.reasons.slice(0,2).join(", "):"";
          const locSightCount=sightings.filter(s=>(s.location_name||"").toLowerCase().includes(loc.name.toLowerCase().slice(0,8))).length;
          return (
            <div key={loc.id||loc.name} className={`lc${selLoc?.name===loc.name?" sel":""}`} onClick={()=>{setSelLoc(loc);}}>
              <div className="lc-top">
                <div style={{flex:1}}>
                  <div className="lc-name">
                    {idx<3&&<span style={{fontSize:"0.6rem",color:idx===0?"#f1c40f":idx===1?"#95a5a6":idx===2?"#cd7f32":"var(--paper2)",marginRight:4}}>
                      {idx===0?"🥇":idx===1?"🥈":"🥉"}
                    </span>}
                    {loc.name}
                  </div>
                  <div className="lc-dist">
                    {loc.distance?.toFixed(1)}km {isCoastal(loc)?"· 🌊":""} {locSightCount>0?`· ${locSightCount} sightings`:""}
                    <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc.name)}&center=${loc.lat},${loc.lng}`} target="_blank" rel="noopener noreferrer" onClick={e=>e.stopPropagation()} style={{marginLeft:5,fontSize:"0.6rem",color:"var(--sky)",textDecoration:"none",opacity:0.8}}>📍 map</a>
                  </div>
                </div>
                <div className={`rdot r${loc.rating?.charAt(0)||"a"}`}/>
              </div>
              <div className="lc-sum">
                {loc.temp!=null ? (
                  <span>{wxIcon(loc.wxCode)} {Math.round(loc.temp)}°C · 💨 {Math.round(loc.wind||0)}km/h {windDirStr(loc.windDir)} · ☁️ {Math.round(loc.cloud||0)}%</span>
                ) : weather?.current?.temperature_2m!=null ? (
                  <span>{wxIcon(weather.current.weather_code)} {Math.round(weather.current.temperature_2m)}°C · 💨 {Math.round(weather.current.wind_speed_10m||0)}km/h {windDirStr(weather.current.wind_direction_10m)} · ☁️ {weather.current.cloud_cover??"—"}%</span>
                ) : weatherError ? (
                  <span style={{color:"var(--red)",fontSize:"0.62rem"}}>⚠️ Weather unavailable — <button style={{background:"none",border:"none",color:"var(--sky)",cursor:"pointer",fontSize:"0.62rem",padding:0}} onClick={e=>{e.stopPropagation();fetchWeather(true);fetchMarine();}}>retry</button></span>
                ) : <span style={{color:"var(--amber)",fontSize:"0.62rem"}}>⏳ Fetching weather…</span>}
              </div>
              {loc.seasonNote&&<div className="lc-why">🌿 {loc.seasonNote}</div>}
              {whyGood&&!loc.seasonNote&&<div className="lc-why">✦ {whyGood}</div>}
              {loc.wxNotes&&loc.wxNotes.length>0&&<div className="lc-wxnote">{loc.wxNotes[0]}</div>}
              {loc.reflNote&&<div className="lc-reflnote">{loc.reflNote}</div>}
              {(()=>{const sv=getSunVantage(loc,hour,sunrise,sunset); return sv?<div className="lc-sunvantage">{sv}</div>:null;})()}
              {bestTime&&<div className="lc-besttime">{bestTime}</div>}
              <div className="lc-tags">{(loc.tags||[]).map(t=><span key={t} className="lt">{t}</span>)}</div>
            </div>
          );
        })}
      </div>
    );
  };

  const NightPanel = () => {
    const moon=getMoonData(selDate);
    const cloud=weather?.current?.cloud_cover||50;
    const astro=getAstroRating(moon,cloud);
    return (
      <div>
        <div className="night-grid">
          <div className="ng-card" style={{borderColor:`${astro.color}33`}}>
            <div className="ng-title">Astro Rating</div>
            <div className="ng-val" style={{color:astro.color}}>{astro.label}</div>
            <div className="ng-sub">Cloud {cloud}% · Moon {moon.illumination}% lit</div>
          </div>
          <div className="ng-card">
            <div className="ng-title">Milky Way</div>
            <div className="ng-val" style={{color:moon.mwRating==="excellent"?"#2ecc71":moon.mwRating==="good"?"#f39c12":"#e74c3c"}}>{moon.mwRating}</div>
            <div className="ng-sub">{moon.mwSeason?"✓ Peak MW season (Feb–May)":"Outside peak season"}</div>
          </div>
          <div className="ng-card">
            <div className="ng-title">Moon Tonight</div>
            <div className="ng-val">{moon.icon} {moon.name}</div>
            <div className="ng-sub">Rises {moon.rise} · Sets {moon.set}</div>
          </div>
          <div className="ng-card">
            <div className="ng-title">Dark Window</div>
            <div className="ng-val" style={{fontSize:"0.85rem"}}>{moon.illumination<30?"Dark skies":moon.illumination<60?"Partial dark":"Moonlit"}</div>
            <div className="ng-sub">Best: before {moon.rise} or after {moon.set}</div>
          </div>
        </div>
        <div style={{fontSize:"0.76rem",color:"var(--paper2)",lineHeight:1.65,padding:"10px 12px",background:"var(--glass)",borderRadius:7,border:"1px solid var(--border2)"}}>
          <strong style={{color:"var(--paper)"}}>Nocturnal species:</strong> Southern Boobook Owl, Tawny Frogmouth, Barn Owl, Australian Owlet-nightjar. <strong style={{color:"var(--paper)"}}>Best dark-sky spots:</strong> Point Nepean (minimal light pollution), Cape Schanck, Greens Bush. <strong style={{color:"var(--paper)"}}>Micro-bats</strong> active over water from dusk — Safety Beach, Martha's Cove.
        </div>
      </div>
    );
  };

  const EbirdPanel = () => {
    if(ebirdLoading)return <div style={{color:"var(--sky)",fontSize:"0.78rem",padding:"10px 0",display:"flex",alignItems:"center",gap:6}}><span className="ai-spin"/>Loading eBird…</div>;
    if(ebirdError)return(
      <div style={{padding:"9px 11px",background:"rgba(231,76,60,0.07)",border:"1px solid rgba(231,76,60,0.18)",borderRadius:7,marginBottom:8}}>
        <div style={{fontWeight:600,color:"#e74c3c",fontSize:"0.75rem",marginBottom:4}}>⚠️ eBird CORS — works once deployed to Netlify</div>
        <div style={{fontSize:"0.68rem",color:"var(--paper2)"}}>{ebirdError}</div>
        <button className="btn btn-sm" style={{marginTop:6,borderColor:"rgba(231,76,60,0.3)",color:"#e74c3c",background:"none"}} onClick={fetchEbird}>↻ Retry</button>
      </div>
    );
    if(!ebirdData.length)return(
      <div style={{textAlign:"center",padding:"12px 0"}}>
        <div style={{color:"var(--paper2)",fontSize:"0.75rem",marginBottom:8}}>eBird data not loaded</div>
        <button className="btn btn-g btn-sm" onClick={fetchEbird}>Load eBird sightings</button>
      </div>
    );
    return(
      <div>
        {ebirdData.map((e,i)=>(
          <div key={i} className="eb-item">
            <div>
              <div className="eb-sp">{e.comName}</div>
              <div className="eb-meta">{e.locName} · {e.obsDt} · ×{e.howMany||1}</div>
            </div>
            {e.exotic&&<span className="eb-badge eb-rare">Notable</span>}
          </div>
        ))}
        <button className="btn-icon" style={{marginTop:6,fontSize:"0.65rem"}} onClick={fetchEbird}>↻ Refresh</button>
      </div>
    );
  };

  // ChatBot rendered inline in JSX (not as nested component) to avoid focus loss on re-render

  const DataTab = () => {
    const [form, setForm] = useState({});
    const spCounts={};sightings.forEach(s=>{spCounts[s.species||"?"]=(spCounts[s.species||"?"]||0)+(s.count||1);});
    const locCounts={};sightings.forEach(s=>{if(s.location_name)locCounts[s.location_name]=(locCounts[s.location_name]||0)+1;});
    const topSp=Object.entries(spCounts).sort((a,b)=>b[1]-a[1]).slice(0,15);
    const topLocs=Object.entries(locCounts).sort((a,b)=>b[1]-a[1]).slice(0,10);
    const [dSub,setDSub]=useState("sightings");
    return (
      <div>
        <div className="sub-tabs">
          {["sightings","add","import"].map(t=>(
            <button key={t} className={`st${dSub===t?" a":""}`} onClick={()=>setDSub(t)}>
              {t==="sightings"?"📋 Sightings":t==="add"?"✚ Add":t==="import"?"📸 Import":""}
            </button>
          ))}
        </div>

        {dSub==="sightings"&&(
          <div>
            {sightings.length===0?<div className="empty"><div className="empty-i">📋</div>No sightings yet</div>
            :sightings.slice(0,60).map((s,i)=>(
              <div key={i} className="sighting-item">
                <div>
                  <div className="si-sp">{s.species||"Unknown"}</div>
                  <div className="si-m">{s.location_name||"—"} · {s.date||"—"} · {s.time_of_day||""}</div>
                  {s.behaviour&&<div className="si-b">{s.behaviour}</div>}
                </div>
                <button className="btn-icon" style={{color:"var(--red)",fontSize:"0.7rem"}} onClick={async()=>{if(s.id){await dbDelete("scout_sightings",s.id);await loadSightings();}}}>✕</button>
              </div>
            ))}
          </div>
        )}

        {dSub==="add"&&(
          <div className="fc">
            <div style={{fontWeight:600,fontSize:"0.82rem",marginBottom:10,color:"var(--gold2)"}}>Log a Sighting</div>
            {[["Species","species","text"],["Location","location_name","text"],["Behaviour","behaviour","text"],["Date","date","date"],["Notes","notes","text"]].map(([label,key,type])=>(
              <div key={key} className="fr full"><div className="fl">{label}</div>
                <input className="fi" type={type} value={form[key]||""} onChange={e=>setForm(p=>({...p,[key]:e.target.value}))}
                  list={key==="location_name"?"loc-list":key==="species"?"sp-list":undefined}/>
              </div>
            ))}
            <datalist id="loc-list">{locations.map(l=><option key={l.name} value={l.name}/>)}</datalist>
            <datalist id="sp-list">{[...new Set(sightings.map(s=>s.species).filter(Boolean))].map(s=><option key={s} value={s}/>)}</datalist>
            <div className="fr"><label className="fl">Time of Day</label>
              <select className="fi" value={form.time_of_day||""} onChange={e=>setForm(p=>({...p,time_of_day:e.target.value}))}>
                <option value="">—</option>{["Dawn","Morning","Midday","Afternoon","Dusk"].map(t=><option key={t}>{t}</option>)}
              </select>
            </div>
            <button className="btn btn-g" onClick={async()=>{if(!form.species)return;await dbInsert("scout_sightings",[{...form,month:form.date?new Date(form.date).getMonth()+1:new Date().getMonth()+1}]);await loadSightings();setForm({});toast("Sighting saved ✓");}}>Save Sighting</button>
          </div>
        )}

        {dSub==="import"&&(
          <div>
            <div style={{background:"rgba(74,144,217,0.07)",border:"1px solid rgba(74,144,217,0.18)",borderRadius:8,padding:"10px 12px",marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{fontWeight:600,fontSize:"0.8rem",color:"var(--sky)"}}>📦 XMP Archive — 666 sightings</div>
                  <div style={{fontSize:"0.67rem",color:"var(--paper2)",marginTop:2}}>34 species · 2021–2026 · Hillview Reserve, Tootgarook + more</div>
                </div>
                <button className="btn btn-sm" disabled={seedStatus==="running"} onClick={seedXmpData}
                  style={{whiteSpace:"nowrap",borderColor:"rgba(74,144,217,0.4)",color:"var(--sky)",background:"none"}}>
                  {seedStatus==="idle"&&"⬆ Seed to DB"}
                  {seedStatus==="done"&&"✓ Seeded"}
                  {seedStatus==="error"&&"✗ Retry"}
                  {seedStatus.startsWith("running")&&<><span className="ai-spin" style={{marginRight:4}}/>{seedStatus.includes(":")?`${seedStatus.split(":")[1]}/666…`:"Starting…"}</>}
                </button>
              </div>
            </div>
            <div style={{fontSize:"0.68rem",color:"var(--gold2)",background:"rgba(201,168,76,0.07)",border:"1px solid rgba(201,168,76,0.14)",borderRadius:6,padding:"6px 10px",marginBottom:8}}>
              💡 Lightroom: select photos → File → Export XMP to File → drop JPEGs + XMPs below
            </div>
            <div className={`dropzone${dragOver?" drag":""}`}
              onDragOver={e=>{e.preventDefault();setDragOver(true);}}
              onDragLeave={()=>setDragOver(false)}
              onDrop={e=>{e.preventDefault();setDragOver(false);processFiles(e.dataTransfer.files);}}
              onClick={()=>fileRef.current?.click()}>
              <input ref={fileRef} type="file" multiple accept=".jpg,.jpeg,.xmp" style={{display:"none"}} onChange={e=>processFiles(e.target.files)}/>
              <div style={{fontSize:"1.5rem",marginBottom:5}}>📸</div>
              <div>Drop photos + XMP sidecars here</div>
              <div style={{fontSize:"0.68rem",color:"var(--paper2)",marginTop:3}}>XMP data used automatically · AI ID only for untagged images</div>
            </div>
            {importItems.length>0&&(
              <>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                  <span style={{fontSize:"0.72rem",color:"var(--paper2)"}}>{importItems.filter(i=>i.status==="done").length}/{importItems.length} ready</span>
                  <div style={{display:"flex",gap:6}}>
                    <button className="btn btn-g btn-sm" onClick={saveAllReady}>Save All</button>
                    <button className="btn btn-sm" style={{borderColor:"var(--border2)",color:"var(--paper2)",background:"none"}} onClick={()=>setImportItems([])}>Clear</button>
                  </div>
                </div>
                {importItems.map(item=>(
                  <div key={item.id} className="imp-item">
                    <div className="imp-row">
                      <img src={item.thumb} className="imp-thumb" alt=""/>
                      <div className="imp-info">
                        {item.status==="analyzing"&&<div style={{color:"var(--sky)",fontSize:"0.7rem",display:"flex",alignItems:"center",gap:5}}><span className="ai-spin"/>Identifying…</div>}
                        {item.status==="done"&&<div style={{fontWeight:600,fontSize:"0.79rem"}}>{item.species||"Unknown"}{item.confidence==="xmp"&&<span style={{fontSize:"0.58rem",color:"var(--gold2)",marginLeft:5}}>✦ XMP</span>}</div>}
                        {item.status==="error"&&<div style={{color:"var(--red)",fontSize:"0.72rem"}}>Error</div>}
                        {item.status==="pending"&&<div style={{color:"var(--paper2)",fontSize:"0.72rem"}}>Queued…</div>}
                        <div className="imp-meta">{item.file.name.replace(/\.(jpg|jpeg)$/i,"")}</div>
                        {item.date&&<div className="imp-meta">{item.date} · {item.time_of_day||""} · {item.location||""}</div>}
                        {item.lens&&<div className="imp-meta">{item.lens}{item.focal_length?` · ${item.focal_length}`:""}{item.shutter?` · ${item.shutter}s`:""}{item.aperture?` · ${item.aperture}`:""}{item.iso?` · ISO${item.iso}`:""}</div>}
                      </div>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  // ─── RENDER ───────────────────────────────────────────────────────────────────
  const isWL = mainTab==="wildlife"||mainTab==="landscape";
  const { season } = seasonal(selDate.getMonth()+1);

  return (
    <div style={{background:"var(--ink)",minHeight:"100vh",color:"var(--paper)"}}>
      <style>{CSS}</style>

      {/* Header */}
      <div className="hdr">
        <div>
          <div className="title">📷 Peninsula Scout</div>
          <div className="subtitle">Mornington Peninsula · Wildlife & Landscape</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <div style={{textAlign:"right"}}>
            <div className="clock">{tick.toLocaleTimeString("en-AU",{hour:"2-digit",minute:"2-digit"})}</div>
            <div className="clock-d">{tick.toLocaleDateString("en-AU",{weekday:"short",day:"numeric",month:"short"})}</div>
          </div>
        </div>
      </div>

      {/* Conditions banner */}
      <CondBar/>

      {/* Nav */}
      <div className="nav">
        {[{id:"wildlife",l:"🦅 Wildlife"},{id:"landscape",l:"🌅 Landscape"},{id:"map",l:"🗺 Map"},{id:"data",l:"📊 Data"},{id:"chat",l:"💬 Chat"}].map(t=>(
          <button key={t.id} className={`nt${mainTab===t.id?" active":""}`} onClick={()=>setMainTab(t.id)}>{t.l}</button>
        ))}
      </div>

      {/* Wildlife / Landscape */}
      {isWL&&(
        <div className="mg">
          {/* LEFT PANEL */}
          <div className="lp">
            <div className="sh">5-Day Forecast</div>
            <ForecastStrip/>
            <div className="sh">Calendar — {calMonth.toLocaleDateString("en-AU",{month:"long",year:"numeric"})}</div>
            <CalView/>
            <div className="sh" style={{marginTop:14}}>
              Locations — {timeWindow==="now"?"Right Now":timeWindow==="sunrise"?"Sunrise Window":timeWindow==="sunset"?"Sunset Window":"Night"} · ranked
            </div>
            <LocList filter={mainTab}/>
          </div>

          {/* RIGHT PANEL */}
          <div className="rp">
            <TimeWindowTabs/>

            {/* AI Analysis — at top */}
            <div className="ai-card" style={{background:"linear-gradient(135deg,rgba(74,144,217,0.05),rgba(107,79,187,0.03))",borderColor:"rgba(74,144,217,0.15)",marginTop:8}}>
              <div className="ai-lbl" style={{color:"var(--sky)"}}>
                {aiLoading?<><span className="ai-spin"/>Analysing {timeWindow} window{selLoc?` · ${selLoc.name}`:""}…</>:"✦ AI Analysis"}
              </div>
              <div className="ai-txt" dangerouslySetInnerHTML={{__html:aiText||(aiLoading?"":"Generating recommendations…")}}/>
            </div>

            {/* Date + refresh header */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8,marginTop:12}}>
              <div>
                <div className="sh" style={{margin:0}}>
                  {mainTab==="wildlife"?"🦅 Wildlife Recommendations":"🌅 Landscape Recommendations"}
                  {selLoc&&<a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(selLoc.name+' '+selLoc.lat+','+selLoc.lng)}`} target="_blank" rel="noopener noreferrer" style={{color:"var(--gold)",fontStyle:"normal",textDecoration:"none",borderBottom:"1px solid rgba(201,168,76,0.35)"}}> — {selLoc.name} 📍</a>}
                </div>
                <div style={{fontSize:"0.63rem",color:"var(--paper2)",marginTop:2}}>
                  {selDate.toLocaleDateString("en-AU",{weekday:"long",day:"numeric",month:"long"})} · {season}
                  {selLoc&&<span style={{color:"var(--paper2)"}}> · click another location to update</span>}
                </div>
              </div>
              <div style={{display:"flex",gap:4}}>
                {selLoc&&<button className="btn-icon" style={{fontSize:"0.65rem",color:"var(--paper2)"}} onClick={()=>setSelLoc(null)}>✕ clear</button>}
                <button className="btn-icon" onClick={()=>runAnalysis(mainTab,timeWindow,selDate,locations,weather,marine,sightings,ebirdData,selLoc)}>↻</button>
              </div>
            </div>

            {/* Night panel */}
            {timeWindow==="night"&&<NightPanel/>}

            {/* Water conditions (landscape) */}
            {mainTab==="landscape"&&marine?.current?.wave_height&&(()=>{
              const wc=waterCondition(marine.current.wave_height,marine.current.wave_period,weather?.current?.wind_speed_10m);
              return(
                <div className="wc-card" style={{background:`${wc.color}0d`,borderColor:`${wc.color}2e`,color:wc.color}}>
                  <div className="wc-lbl">Water Conditions</div>
                  <div className="wc-val">{wc.label}</div>
                  <div className="wc-desc">{wc.desc} · {marine.current.wave_height}m waves · {marine.current.swell_wave_height||"?"}m swell · {marine.current.wave_period||"?"}s period</div>
                </div>
              );
            })()}

            {/* eBird (wildlife) */}
            {mainTab==="wildlife"&&(
              <>
                <div className="sh">eBird — Recent Nearby</div>
                <EbirdPanel/>
              </>
            )}

            {/* 7-day wave outlook (landscape) */}
            {mainTab==="landscape"&&weather&&(
              <>
                <div className="sh">7-Day Wave Outlook</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:3}}>
                  {(weather.daily?.sunrise||[]).slice(0,7).map((_,i)=>{
                    const d=new Date();d.setDate(d.getDate()+i);
                    const wMax=marine?.daily?.wave_height_max?.[i]||0;
                    const sMax=marine?.daily?.swell_wave_height_max?.[i]||0;
                    const rain=weather.daily?.precipitation_sum?.[i]||0;
                    const wc=waterCondition(wMax,8,0);
                    return(
                      <div key={i} style={{textAlign:"center",background:"var(--glass)",border:`1px solid ${wc.color}28`,borderRadius:6,padding:"5px 3px",cursor:"pointer"}} onClick={()=>{const nd=new Date();nd.setDate(nd.getDate()+i);setSelDate(nd);}}>
                        <div style={{fontSize:"0.6rem",color:"var(--paper2)"}}>{d.toLocaleDateString("en-AU",{weekday:"short"})}</div>
                        <div style={{fontSize:"0.72rem",fontWeight:600,color:wc.color,marginTop:1}}>{wc.label}</div>
                        <div style={{fontSize:"0.6rem",color:"var(--paper2)"}}>{wMax.toFixed(1)}m</div>
                        {rain>0.5&&<div style={{fontSize:"0.57rem",color:"var(--sky)"}}>{rain.toFixed(1)}mm</div>}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Map */}
      {mainTab==="map"&&(
        <div style={{padding:"14px 18px"}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:9}}>
            <div className="sh" style={{margin:0}}>Location Map — 40km radius · Dromana</div>
            <span style={{fontSize:"0.7rem",color:"var(--paper2)"}}>
              <span style={{color:"#2ecc71"}}>●</span> Good &nbsp;<span style={{color:"#f39c12"}}>●</span> OK &nbsp;<span style={{color:"#e74c3c"}}>●</span> Poor
            </span>
          </div>
          <div className="map-wrap"><div id="scout-map" ref={mapRef}/></div>
          {selLoc&&(
            <div className="fc" style={{marginTop:11}}>
              <div style={{fontWeight:600,color:"var(--gold)",marginBottom:3}}>
                {selLoc.name}
                <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(selLoc.name)}&center=${selLoc.lat},${selLoc.lng}`} target="_blank" rel="noopener noreferrer" style={{marginLeft:8,fontSize:"0.68rem",color:"var(--sky)",textDecoration:"none",fontWeight:400}}>📍 Open in Maps</a>
              </div>
              <div style={{fontSize:"0.7rem",color:"var(--paper2)",marginBottom:5}}>{selLoc.distance?.toFixed(1)}km · {(selLoc.tags||[]).join(", ")}</div>
              <div style={{fontSize:"0.76rem"}}>{selLoc.notes}</div>
            </div>
          )}
          {!mapLoaded&&<div style={{textAlign:"center",padding:36,color:"var(--paper2)"}}>Loading map…</div>}
        </div>
      )}

      {/* Chat */}
      {mainTab==="chat"&&(
        <div style={{padding:"14px 18px",maxWidth:760}}>
          <div className="sh">💬 Photography Intelligence Chat</div>
          <div style={{fontSize:"0.72rem",color:"var(--paper2)",marginBottom:10}}>Your sightings + eBird + current conditions — ask anything</div>
          <div className="chat-wrap">
            <div className="chat-msgs">
              {chatMsgs.map((m,i)=>(
                <div key={i} className={`chat-msg ${m.role}`} dangerouslySetInnerHTML={{__html:m.text.replace(/\n/g,"<br/>")}}/>
              ))}
              {chatLoading&&<div className="chat-msg ai" style={{opacity:0.7}}><span className="ai-spin" style={{marginRight:6}}/>Thinking…</div>}
              <div ref={chatEndRef}/>
            </div>
            <div className="chat-suggestions">
              {["Best spot for Wedge-tail today?","Where to find fairy-wrens this morning?","Is the light good for landscape right now?","What's been seen nearby this week?","Best beach for sunrise tomorrow?","Aurora chance tonight?"].map(s=>(
                <span key={s} className="chat-sug" onClick={()=>sendChat(s)}>{s}</span>
              ))}
            </div>
            <div className="chat-input-row">
              <input className="chat-input" value={chatInput} onChange={e=>setChatInput(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&sendChat(chatInput)}
                placeholder="Ask about species, locations, conditions…"/>
              <button className="btn btn-g" onClick={()=>sendChat(chatInput)} disabled={chatLoading}>Send</button>
            </div>
          </div>
        </div>
      )}

      {/* Data */}
      {mainTab==="data"&&(
        <div className="mg">
          <div className="lp"><DataTab/></div>
          <div className="rp">
            <div className="sh">Seasonal Intelligence</div>
            <div className="ai-card" style={{background:"var(--glass)",borderColor:"var(--border)"}}>
              <div className="ai-lbl" style={{color:"var(--gold)"}}>✦ {season} Overview</div>
              <div className="ai-txt">
                <p>{seasonal(tick.getMonth()+1).behaviour}</p>
                <h4>📍 Your Top Locations</h4>
                {(()=>{const f={};sightings.forEach(s=>{if(s.location_name)f[s.location_name]=(f[s.location_name]||0)+1;});const top=Object.entries(f).sort((a,b)=>b[1]-a[1]).slice(0,8);
                  return top.length>0?top.map(([l,c])=>(
                    <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"3px 0",borderBottom:"1px solid rgba(255,255,255,0.04)",fontSize:"0.76rem"}}>
                      <span>{l}</span><span style={{color:"var(--gold)"}}>{c} records</span>
                    </div>
                  )):<div style={{color:"var(--paper2)",fontSize:"0.76rem"}}>Seed the XMP archive to populate.</div>;
                })()}
                <h4>🦅 Species Tally</h4>
                {(()=>{const sc={};sightings.forEach(s=>{sc[s.species]=(sc[s.species]||0)+(s.count||1);});const sorted=Object.entries(sc).sort((a,b)=>b[1]-a[1]).slice(0,20);
                  return sorted.length>0?sorted.map(([sp,c])=>(
                    <div key={sp} style={{display:"flex",justifyContent:"space-between",padding:"3px 0",borderBottom:"1px solid rgba(255,255,255,0.04)",fontSize:"0.76rem"}}>
                      <span>{sp}</span><span style={{color:"var(--gold2)"}}>×{c}</span>
                    </div>
                  )):<div style={{color:"var(--paper2)",fontSize:"0.76rem"}}>No species recorded yet.</div>;
                })()}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {status&&<div className="toast">{status}</div>}
    </div>
  );
}
