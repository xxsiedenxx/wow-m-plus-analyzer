const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache'
};

function realmToSlug(realm) {
  return realm.toLowerCase().replace(/[''']/g, '').replace(/\s+/g, '-');
}

function slugifyForRIO(name) {
  return (name || '').toLowerCase()
    .replace(/['''`\u2018\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatTime(ms) {
  if (!ms) return '?:??';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function extractSeason(allRuns) {
  for (const run of (allRuns || [])) {
    const m = (run.url || '').match(/\/(season-[a-z0-9-]+)\//);
    if (m) return m[1];
  }
  return 'season-tww-2';
}

// Rough estimate of max score achievable at a given key level
function getApproxMaxScore(keyLevel) {
  const base = 38;
  const factor = 1.115;
  return Math.round(base * Math.pow(factor, Math.max(0, keyLevel - 2)));
}

function computeGrade(score, timingRate, dungeonCount) {
  let points = 0;

  if (score >= 4500) points += 65;
  else if (score >= 4000) points += 58;
  else if (score >= 3500) points += 52;
  else if (score >= 3000) points += 46;
  else if (score >= 2500) points += 40;
  else if (score >= 2000) points += 34;
  else if (score >= 1500) points += 28;
  else if (score >= 1000) points += 20;
  else if (score >= 500)  points += 12;
  else                    points += 5;

  points += Math.round(timingRate * 25);
  points += Math.min(10, Math.round(Math.min(dungeonCount, 8) * 1.25));

  const total = Math.min(100, points);
  if (total >= 95) return 'A+';
  if (total >= 88) return 'A';
  if (total >= 82) return 'A-';
  if (total >= 76) return 'B+';
  if (total >= 70) return 'B';
  if (total >= 64) return 'B-';
  if (total >= 58) return 'C+';
  if (total >= 52) return 'C';
  if (total >= 46) return 'C-';
  if (total >= 38) return 'D+';
  if (total >= 28) return 'D';
  return 'F';
}

function getGradeDescription(grade, data) {
  const { depleted } = data;
  switch (grade) {
    case 'A+': return 'Elite performer. Dominating top-end keys with exceptional consistency.';
    case 'A':  return 'Excellent performance. Crushing high keys — borderline elite.';
    case 'A-': return 'Very strong. High-level keys timed consistently. Push the ceiling.';
    case 'B+': return 'Strong performer. Timing hard keys well with minor slip-ups.';
    case 'B':  return 'Solid performance. Good key levels with reasonable timing. Room to optimize.';
    case 'B-': return 'Above average. Timing keys decently but consistency needs work.';
    case 'C+':
      if (depleted > 2) return 'Completing keys but depleting too many. Consistency is the bottleneck.';
      return 'Completing keys, but not timing them fast enough. DPS is average.';
    case 'C':  return 'Average. Keys are getting done but slow clears are capping your score.';
    case 'C-': return 'Below average. Focus on dungeon knowledge and lower, faster clears.';
    case 'D+':
    case 'D':  return 'Getting started. Learn routes and mechanics before pushing key levels.';
    default:   return 'Very early in M+. Every dungeon completion builds your score.';
  }
}

function generateFixes(dungeons, metrics, wclData) {
  const fixes = [];
  const depleted = dungeons.filter(d => d.upgrades === 0);
  const bareTimes = dungeons.filter(d => d.upgrades === 1 && d.timePercent > 88);
  const sortedByScore = [...dungeons].sort((a, b) => a.score - b.score);
  const POOL_SIZE = 8;

  // WCL-based fixes (DPS parse)
  if (wclData?.bestParse != null) {
    const best = wclData.bestParse;
    const median = wclData.medianParse ?? best;
    const consistency = best - median;

    if (median < 50) {
      fixes.push({
        priority: 1,
        title: 'Do More Damage',
        description: `Your typical DPS is around the ${Math.round(median)}th percentile — below average. The top players at your key level do significantly more. Use cooldowns on big trash pulls, not just bosses. Stay in melee/range and never stand idle between pulls.${best > 60 ? ` You can do better — your best parse (${Math.round(best)}%) proves it.` : ''}`,
        target: `Target: Get median DPS parse above 55% in every dungeon`
      });
    } else if (best < 70) {
      fixes.push({
        priority: 1,
        title: 'Push Your DPS Higher',
        description: `Your best parse is ${Math.round(best)}% — okay but not great. Check your spec's top players on Warcraft Logs for talent and rotation tips. Focus on hitting ability priority correctly and not missing cooldown windows.`,
        target: `Target: Best parse above 70%`
      });
    }

    if (consistency > 25 && fixes.length < 3) {
      fixes.push({
        priority: fixes.length + 1,
        title: 'Be More Consistent',
        description: `Your best parse (${Math.round(best)}%) is way above your median (${Math.round(median)}%) — a ${Math.round(consistency)} point gap. Good players keep this under 20. Some runs you're playing great, others you're off. Take a break after 2 failed keys in a row.`,
        target: `Target: Bring median parse within 20 points of your best`
      });
    }
  }

  // Depleted keys fix
  if (depleted.length > 0 && fixes.length < 3) {
    fixes.push({
      priority: fixes.length + 1,
      title: `Stop Depleting Keys (${depleted.length} dungeon${depleted.length > 1 ? 's' : ''})`,
      description: `Depleted runs in: ${depleted.map(d => d.name).join(', ')}. Depleted keystones score lower and break the stone. Drop 2–3 key levels until you're timing consistently, then climb back up.`,
      target: `Action: Run depleted dungeons 2–3 levels lower until timed`
    });
  }

  // Worst dungeon gap
  if (dungeons.length > 1 && fixes.length < 3) {
    const worst = sortedByScore[0];
    const best = sortedByScore[sortedByScore.length - 1];
    const gap = best.score - worst.score;
    if (gap > 40) {
      fixes.push({
        priority: fixes.length + 1,
        title: `Boost Your Weakest: ${worst.name}`,
        description: `${worst.name} at +${worst.keyLevel} is ${gap.toFixed(0)} score behind your best dungeon. Watch a route video on YouTube, study the skips, and push it 2 levels higher.`,
        target: `Current: +${worst.keyLevel} (${worst.score.toFixed(0)} pts) → Target: +${worst.keyLevel + 2}`
      });
    }
  }

  // Missing dungeons
  if (dungeons.length < POOL_SIZE && fixes.length < 3) {
    const missing = POOL_SIZE - dungeons.length;
    fixes.push({
      priority: fixes.length + 1,
      title: `Complete Missing Dungeons (${missing} left)`,
      description: `Every dungeon in the pool contributes to your M+ score. You're leaving free rating on the table. Queue the missing dungeons even at low key levels — any completion counts.`,
      target: `Action: Complete all ${POOL_SIZE} dungeons at +10 or higher`
    });
  }

  // Bare times (barely timed)
  if (fixes.length < 3 && bareTimes.length > 0) {
    fixes.push({
      priority: fixes.length + 1,
      title: 'Improve Clear Speed',
      description: `${bareTimes.map(d => d.name).join(', ')} were barely timed (over 88% of the timer used). Faster clears = higher upgrades = better score. Focus on skips, CC usage, and bloodlust timing.`,
      target: `Target: +2 upgrade (under 80% of par time) in slow dungeons`
    });
  }

  // Push higher
  if (fixes.length < 3 && dungeons.length > 0) {
    const avgLevel = Math.round(dungeons.reduce((s, d) => s + d.keyLevel, 0) / dungeons.length);
    fixes.push({
      priority: fixes.length + 1,
      title: 'Push Higher Key Levels',
      description: `You're timing your current range well. Each key level adds ~15–20 points per dungeon. Start pushing 2–3 levels above your current best to build score momentum.`,
      target: `Target: Push to +${avgLevel + 3} in your top 2–3 dungeons`
    });
  }

  // Consistency padding
  while (fixes.length < 3) {
    fixes.push({
      priority: fixes.length + 1,
      title: 'Maintain Consistency',
      description: `Keep pushing keys and maintain a high timing rate across all dungeons. Consistency is what separates good players from great ones.`,
      target: `Target: Time 90%+ of your runs`
    });
  }

  return fixes.slice(0, 3);
}

async function fetchRaiderIO(name, realm, region) {
  const realmSlug = realmToSlug(realm);
  const url = 'https://raider.io/api/v1/characters/profile';
  const params = {
    region: region.toLowerCase(),
    realm: realmSlug,
    name: name.toLowerCase(),
    fields: [
      'mythic_plus_scores_by_season:current',
      'mythic_plus_best_runs',
      'mythic_plus_alternate_runs',
      'mythic_plus_ranking',
      'gear',
      'class',
      'race',
      'active_spec_name',
      'active_spec_role',
      'thumbnail_url',
      'profile_url'
    ].join(',')
  };

  const response = await axios.get(url, {
    params,
    timeout: 15000,
    headers: { 'Accept': 'application/json', 'User-Agent': 'WoW-M-Plus-Analyzer/1.0' }
  });
  return response.data;
}

// WCL API v2: OAuth2 client credentials + GraphQL (replaces broken HTML scraping)
// WCL returns 403 to server-side HTTP fetches, and __NEXT_DATA__ only has shell HTML.
// Set WCL_CLIENT_ID and WCL_CLIENT_SECRET in Railway env (create at warcraftlogs.com/api/clients).
let _wclToken = null;
let _wclTokenExpiry = 0;

async function getWCLToken() {
  if (_wclToken && Date.now() < _wclTokenExpiry - 60000) return _wclToken;

  const clientId = process.env.WCL_CLIENT_ID;
  const clientSecret = process.env.WCL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('WCL_CLIENT_ID / WCL_CLIENT_SECRET not set — create API keys at warcraftlogs.com/api/clients');
  }

  const resp = await axios.post(
    'https://www.warcraftlogs.com/oauth/token',
    'grant_type=client_credentials',
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      auth: { username: clientId, password: clientSecret },
      timeout: 10000
    }
  );

  _wclToken = resp.data.access_token;
  _wclTokenExpiry = Date.now() + resp.data.expires_in * 1000;
  return _wclToken;
}

async function fetchWCL(name, realm, region) {
  const token = await getWCLToken();
  const realmSlug = realmToSlug(realm);
  const baseUrl = `https://www.warcraftlogs.com/character/${region.toLowerCase()}/${realmSlug}/${name.toLowerCase()}`;

  // zone 47 = The War Within M+ current season
  const query = `
    query GetCharacterRankings($name: String!, $serverSlug: String!, $serverRegion: String!) {
      characterData {
        character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
          name
          classID
          zoneRankings(zoneID: 47)
        }
      }
    }
  `;

  const resp = await axios.post(
    'https://www.warcraftlogs.com/api/v2/client',
    { query, variables: { name: name.toLowerCase(), serverSlug: realmSlug, serverRegion: region.toUpperCase() } },
    {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 15000
    }
  );

  const errors = resp.data?.errors;
  if (errors?.length) throw new Error(errors[0].message);

  const character = resp.data?.data?.characterData?.character;
  if (!character) return null;

  const zoneRankings = character.zoneRankings || null;

  const bestParse = zoneRankings?.bestPerformanceAverage ?? null;
  const medianParse = zoneRankings?.medianPerformanceAverage ?? null;

  const dungeonRankings = (zoneRankings?.rankings || []).map(r => ({
    encounter: r.encounter?.name || r.name || '',
    rankPercent: r.rankPercent ?? r.bestPercent ?? null,
    medianPercent: r.medianPercent ?? null,
    bestAmount: r.bestAmount ?? null,
    medianAmount: r.medianAmount ?? null,
    spec: r.spec ?? null
  }));

  if (bestParse === null && dungeonRankings.length === 0) return null;

  return { bestParse, medianParse, dungeonRankings, wclUrl: baseUrl };
}

// Fetch top players for a specific dungeon at a given key level and spec
async function fetchDungeonRankings(region, dungeonSlug, keyLevel, className, specName, season) {
  const url = 'https://raider.io/api/v1/mythic-plus/rankings/characters';
  const params = {
    region: region.toLowerCase(),
    dungeon: dungeonSlug,
    season,
    class: slugifyForRIO(className),
    spec: slugifyForRIO(specName),
    page: 0
  };

  const response = await axios.get(url, {
    params,
    timeout: 10000,
    headers: { 'Accept': 'application/json', 'User-Agent': 'WoW-M-Plus-Analyzer/1.0' }
  });

  const characters = response.data?.rankings?.rankedCharacters || [];

  // Prefer exact key level match, fall back to ±1, then take whatever's there
  let filtered = characters.filter(c => (c.run?.mythic_level || 0) === keyLevel);
  if (filtered.length < 3) {
    filtered = characters.filter(c => Math.abs((c.run?.mythic_level || 0) - keyLevel) <= 1);
  }
  if (filtered.length === 0) {
    filtered = characters.slice(0, 10);
  }

  return filtered.slice(0, 5).map(c => ({
    name: c.character?.name || 'Unknown',
    realm: c.character?.realm?.name || c.character?.realm?.slug || '',
    ilvl: c.character?.gear?.item_level_equipped || null,
    keyLevel: c.run?.mythic_level || keyLevel,
    score: parseFloat((c.run?.score || c.score || 0).toFixed(1)),
    clearTimeMs: c.run?.clear_time_ms || null,
    clearTimeFormatted: formatTime(c.run?.clear_time_ms),
    parTimeMs: c.run?.par_time_ms || null,
    url: c.run?.url || null,
    rank: c.rank || null
  }));
}

function processBestRuns(bestRuns, alternateRuns) {
  const allRuns = [...(bestRuns || []), ...(alternateRuns || [])];
  const dungeonMap = {};

  for (const run of allRuns) {
    const key = run.dungeon;
    if (!dungeonMap[key] || run.score > dungeonMap[key].score) {
      dungeonMap[key] = run;
    }
  }

  return Object.values(dungeonMap).map(run => {
    const timePercent = run.par_time_ms > 0
      ? parseFloat(((run.clear_time_ms / run.par_time_ms) * 100).toFixed(1))
      : 100;

    let status = 'red';
    if (run.num_keystone_upgrades >= 2) status = 'green';
    else if (run.num_keystone_upgrades === 1) status = 'yellow';

    const timeSavedMs = run.par_time_ms - run.clear_time_ms;

    return {
      name: run.dungeon,
      slug: slugifyForRIO(run.dungeon),
      shortName: run.short_name || run.dungeon.split(' ').map(w => w[0]).join('').toUpperCase(),
      keyLevel: run.mythic_level,
      score: parseFloat(run.score.toFixed(1)),
      clearTimeMs: run.clear_time_ms,
      parTimeMs: run.par_time_ms,
      clearTimeFormatted: formatTime(run.clear_time_ms),
      parTimeFormatted: formatTime(run.par_time_ms),
      timeSavedMs,
      timeSavedFormatted: timeSavedMs >= 0 ? `-${formatTime(timeSavedMs)}` : `+${formatTime(-timeSavedMs)}`,
      timePercent,
      upgrades: run.num_keystone_upgrades,
      status,
      affixes: run.affixes ? run.affixes.map(a => a.name) : [],
      url: run.url || null,
      estimatedMaxScore: parseFloat((getApproxMaxScore(run.mythic_level) * 1.08).toFixed(1))
    };
  }).sort((a, b) => b.score - a.score);
}

// ── Main analyze endpoint ──
app.post('/api/analyze', async (req, res) => {
  const { characterName, server, region } = req.body || {};

  if (!characterName || !server || !region) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: characterName, server, region'
    });
  }

  try {
    let rioData;
    try {
      rioData = await fetchRaiderIO(characterName, server, region);
    } catch (err) {
      const status = err.response?.status;
      const apiMsg = err.response?.data?.message;
      if (status === 400 || status === 404) {
        throw new Error(
          apiMsg ||
          `Character "${characterName}" on "${server}" (${region.toUpperCase()}) not found. ` +
          `Check spelling and make sure they have completed at least one Mythic+ run tracked by Raider.IO.`
        );
      }
      throw new Error(`Could not reach Raider.IO: ${err.message}`);
    }

    // WCL API v2 — best effort, never blocks response
    let wclData = null;
    let wclError = null;
    try {
      wclData = await fetchWCL(characterName, server, region);
    } catch (e) {
      wclError = e.message;
    }

    const dungeons = processBestRuns(rioData.mythic_plus_best_runs, rioData.mythic_plus_alternate_runs);

    // Extract season from run URLs for comparison calls
    const allRuns = [...(rioData.mythic_plus_best_runs || []), ...(rioData.mythic_plus_alternate_runs || [])];
    const season = extractSeason(allRuns);

    const scores = rioData.mythic_plus_scores_by_season?.current || {};
    const overallScore = scores.all || 0;

    const timedRuns = dungeons.filter(d => d.upgrades > 0);
    const timingRate = dungeons.length > 0 ? timedRuns.length / dungeons.length : 0;
    const depletedCount = dungeons.filter(d => d.upgrades === 0).length;
    const avgKeyLevel = dungeons.length > 0
      ? dungeons.reduce((s, d) => s + d.keyLevel, 0) / dungeons.length
      : 0;

    const scoreEfficiency = dungeons.length > 0
      ? dungeons.reduce((sum, d) => {
          const estMax = getApproxMaxScore(d.keyLevel);
          return sum + Math.min(100, (d.score / estMax) * 100);
        }, 0) / dungeons.length
      : 0;

    const grade = computeGrade(overallScore, timingRate, dungeons.length);
    const gradeCtx = { timingRate, depleted: depletedCount, avgKeyLevel, score: overallScore };
    const gradeDescription = getGradeDescription(grade, gradeCtx);
    const fixes = generateFixes(dungeons, gradeCtx, wclData);

    res.json({
      success: true,
      data: {
        character: {
          name: rioData.name,
          realm: rioData.realm,
          region: (rioData.region || region).toUpperCase(),
          class: rioData.class,
          spec: rioData.active_spec_name,
          role: rioData.active_spec_role,
          race: rioData.race,
          thumbnail: rioData.thumbnail_url,
          ilvl: rioData.gear?.item_level_equipped || null,
          rioUrl: rioData.profile_url
        },
        season,
        grade: {
          letter: grade,
          description: gradeDescription,
          score: overallScore,
          metrics: {
            overallScore,
            dpsScore: scores.dps || null,
            healScore: scores.healer || null,
            tankScore: scores.tank || null,
            timingRate: parseFloat(timingRate.toFixed(3)),
            timingRatePct: parseFloat((timingRate * 100).toFixed(1)),
            depleted: depletedCount,
            avgKeyLevel: parseFloat(avgKeyLevel.toFixed(1)),
            scoreEfficiency: parseFloat(scoreEfficiency.toFixed(1)),
            rankWorld: rioData.mythic_plus_ranking?.world || null,
            rankRegion: rioData.mythic_plus_ranking?.region || null,
            rankRealm: rioData.mythic_plus_ranking?.realm || null
          }
        },
        dungeons,
        fixes,
        wclData: wclData || null,
        wclError: wclError || null
      }
    });

  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── Comparison endpoint: top 5 same-spec players at same key level, closest ilvl ──
app.post('/api/compare', async (req, res) => {
  const { dungeonSlug, dungeonName, keyLevel, className, specName, region, playerIlvl, season } = req.body || {};

  if (!dungeonSlug || !keyLevel || !className || !specName || !region) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  try {
    let players = await fetchDungeonRankings(
      region, dungeonSlug, parseInt(keyLevel), className, specName, season || 'season-tww-2'
    );

    // Sort by ilvl proximity when both sides have ilvl data
    if (playerIlvl && players.some(p => p.ilvl != null)) {
      players.sort((a, b) =>
        Math.abs((a.ilvl || 9999) - playerIlvl) - Math.abs((b.ilvl || 9999) - playerIlvl)
      );
    }

    res.json({ success: true, data: { players, dungeonName, keyLevel } });
  } catch (err) {
    // Return graceful empty result instead of erroring
    res.json({ success: false, error: err.message, data: { players: [] } });
  }
});

// ── WCL centralized query helper ──
async function wclQuery(queryStr, variables) {
  const token = await getWCLToken();
  const resp = await axios.post(
    'https://www.warcraftlogs.com/api/v2/client',
    { query: queryStr, variables },
    {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 20000
    }
  );
  const errors = resp.data?.errors;
  if (errors?.length) throw new Error(errors[0].message);
  return resp.data?.data;
}

// Get best-ranked dungeon log (reportCode + fightID + encounterID) from zoneRankings
async function getCharBestLog(name, realm, region, zoneID) {
  const realmSlug = realmToSlug(realm);
  const data = await wclQuery(
    `query GetZoneRankings($name: String!, $serverSlug: String!, $serverRegion: String!, $zoneID: Int!) {
      characterData {
        character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
          zoneRankings(zoneID: $zoneID)
        }
      }
    }`,
    { name: name.toLowerCase(), serverSlug: realmSlug, serverRegion: region.toUpperCase(), zoneID: parseInt(zoneID) }
  );
  const rankings = data?.characterData?.character?.zoneRankings?.rankings || [];
  const best = rankings
    .filter(r => r.report?.code && r.report?.fightID != null)
    .sort((a, b) => (b.rankPercent || 0) - (a.rankPercent || 0))[0];
  if (!best) return null;
  return {
    encounterID: best.encounter?.id,
    encounterName: best.encounter?.name,
    reportCode: best.report.code,
    fightID: best.report.fightID,
    rankPercent: best.rankPercent
  };
}

// Fetch DamageDone table for a specific player in a specific fight
async function getReportTable(reportCode, fightID, characterName) {
  const filterExpr = `source.name = "${characterName}"`;
  const data = await wclQuery(
    `query GetTable($code: String!, $fightIDs: [Int]!, $filterExpression: String) {
      reportData {
        report(code: $code) {
          table(fightIDs: $fightIDs, dataType: DamageDone, filterExpression: $filterExpression)
        }
      }
    }`,
    { code: reportCode, fightIDs: [fightID], filterExpression: filterExpr }
  );
  const tableData = data?.reportData?.report?.table?.data;
  if (!tableData) return null;
  return { totalTime: tableData.totalTime || 0, entries: tableData.entries || [] };
}

// Normalize ability entries into {name, damagePercent, cpm, ...}
function processAbilities(entries, totalTimeMs) {
  if (!entries?.length || !totalTimeMs) return [];
  const totalDmg = entries.reduce((s, e) => s + (e.total || 0), 0);
  const durationMin = totalTimeMs / 60000;
  return entries
    .filter(e => e.total > 0 && e.name && !e.name.startsWith('(') && e.name !== 'Unknown')
    .map(e => ({
      name: e.name,
      id: e.id || 0,
      total: e.total,
      hitCount: e.hitCount || 0,
      damagePercent: totalDmg > 0 ? (e.total / totalDmg) * 100 : 0,
      cpm: durationMin > 0 ? (e.hitCount || 0) / durationMin : 0,
      icon: e.icon || ''
    }))
    .sort((a, b) => b.total - a.total);
}

// Get top-ranked players for an encounter+spec, filtered by ilvl bracket
async function getTopEncounterPlayers(encounterID, specName, className, playerIlvl) {
  const wclClass = (className || '').replace(/\s+/g, ''); // "Death Knight" → "DeathKnight"
  const data = await wclQuery(
    `query GetEncRankings($encounterID: Int!, $specName: String!, $className: String!) {
      worldData {
        encounter(id: $encounterID) {
          characterRankings(specName: $specName, className: $className)
        }
      }
    }`,
    { encounterID: parseInt(encounterID), specName, className: wclClass }
  );
  const rankings = data?.worldData?.encounter?.characterRankings?.rankings || [];

  let filtered = [];
  let bracketUsed = null;
  if (playerIlvl) {
    for (const spread of [2, 4, 6]) {
      filtered = rankings.filter(r => r.report?.code && Math.abs((r.bracketData || 0) - playerIlvl) <= spread);
      if (filtered.length >= 5) { bracketUsed = spread; break; }
    }
  }
  if (filtered.length < 5) {
    filtered = rankings.filter(r => r.report?.code);
    bracketUsed = null;
  }

  return {
    players: filtered.slice(0, 5),
    bracketMin: bracketUsed ? playerIlvl - bracketUsed : null,
    bracketMax: bracketUsed ? playerIlvl + bracketUsed : null
  };
}

// Average ability data across multiple peers (accounts for abilities not used by all)
function averageAbilities(peerData) {
  if (!peerData.length) return [];
  const map = {};
  for (const { abilities } of peerData) {
    for (const a of abilities.slice(0, 20)) {
      if (!map[a.name]) map[a.name] = { name: a.name, id: a.id, icon: a.icon, sumDmgPct: 0, sumCpm: 0 };
      map[a.name].sumDmgPct += a.damagePercent;
      map[a.name].sumCpm += a.cpm;
    }
  }
  const total = peerData.length;
  return Object.values(map)
    .map(a => ({ name: a.name, id: a.id, icon: a.icon, avgDmgPct: a.sumDmgPct / total, avgCpm: a.sumCpm / total }))
    .sort((a, b) => b.avgDmgPct - a.avgDmgPct);
}

// ── Ability Compare endpoint ──
app.post('/api/ability-compare', async (req, res) => {
  const { characterName, server, region, zoneID = 47 } = req.body || {};
  if (!characterName || !server || !region) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  try {
    // Fetch RIO for ilvl, class, spec
    let playerIlvl = null, playerSpec = null, playerClass = null, canonicalName = characterName;
    try {
      const rio = await fetchRaiderIO(characterName, server, region);
      playerIlvl = rio.gear?.item_level_equipped || null;
      playerSpec  = rio.active_spec_name || null;
      playerClass = rio.class || null;
      canonicalName = rio.name || characterName; // properly capitalized
    } catch (_) {}

    // Get best log (reportCode, fightID, encounterID)
    const bestLog = await getCharBestLog(characterName, server, region, zoneID);
    if (!bestLog?.encounterID) {
      return res.json({ success: false, error: 'No WCL logs found. Log a run to Warcraft Logs first.', data: null });
    }

    // Get player's damage breakdown
    const playerTable = await getReportTable(bestLog.reportCode, bestLog.fightID, canonicalName);
    if (!playerTable?.totalTime) {
      return res.json({ success: false, error: 'Could not load ability data from the WCL report.', data: null });
    }
    const playerAbilities = processAbilities(playerTable.entries, playerTable.totalTime);

    // Get top 5 peers (same encounter + spec, ilvl bracket)
    const specName  = playerSpec || 'Unknown';
    const className = playerClass || 'Unknown';
    const { players: topPlayers, bracketMin, bracketMax } =
      await getTopEncounterPlayers(bestLog.encounterID, specName, className, playerIlvl);

    // Fetch peer ability tables in parallel
    const peerResults = await Promise.allSettled(
      topPlayers.map(p =>
        getReportTable(p.report.code, p.report.fightID, p.name)
          .then(table => ({ p, table }))
      )
    );

    const peerData = peerResults
      .filter(r => r.status === 'fulfilled' && r.value?.table?.totalTime)
      .map(r => ({ player: r.value.p, abilities: processAbilities(r.value.table.entries, r.value.table.totalTime) }));

    const avgAbilities = averageAbilities(peerData);

    // Build combined per-ability comparison
    const playerMap = Object.fromEntries(playerAbilities.map(a => [a.name, a]));
    const avgMap    = Object.fromEntries(avgAbilities.map(a => [a.name, a]));
    const topNames  = [...new Set([
      ...playerAbilities.slice(0, 12).map(a => a.name),
      ...avgAbilities.slice(0, 12).map(a => a.name)
    ])];
    const combined = topNames.map(name => ({
      name,
      playerDmgPct: playerMap[name]?.damagePercent || 0,
      playerCpm:    playerMap[name]?.cpm || 0,
      avgDmgPct:    avgMap[name]?.avgDmgPct || 0,
      avgCpm:       avgMap[name]?.avgCpm || 0
    })).sort((a, b) => Math.max(b.playerDmgPct, b.avgDmgPct) - Math.max(a.playerDmgPct, a.avgDmgPct));

    const missingAbilities = avgAbilities
      .filter(a => a.avgDmgPct > 1.5 && !playerMap[a.name])
      .slice(0, 5)
      .map(a => ({ name: a.name, avgDmgPct: a.avgDmgPct, avgCpm: a.avgCpm }));

    const underusedAbilities = combined
      .filter(a => a.avgCpm > 0.4 && a.playerCpm > 0 && a.playerCpm < a.avgCpm * 0.5)
      .slice(0, 5)
      .map(a => ({ name: a.name, playerCpm: a.playerCpm, avgCpm: a.avgCpm, ratio: a.playerCpm / a.avgCpm }));

    res.json({
      success: true,
      data: {
        dungeon: bestLog.encounterName,
        rankPercent: bestLog.rankPercent,
        fightDurationMs: playerTable.totalTime,
        playerAbilities: playerAbilities.slice(0, 15),
        avgAbilities: avgAbilities.slice(0, 15),
        combined: combined.slice(0, 15),
        missingAbilities,
        underusedAbilities,
        peers: topPlayers.map((p, i) => ({
          name: p.name,
          realm: p.serverSlug || '',
          region: p.serverRegion || region,
          ilvl: p.bracketData || null,
          dps: Math.round(p.amount || 0),
          rank: p.rank || i + 1,
          rankPercent: p.rankPercent || null
        })),
        bracketMin,
        bracketMax,
        playerIlvl
      }
    });

  } catch (err) {
    console.error('[ability-compare]', err.message);
    res.json({ success: false, error: err.message, data: null });
  }
});

// Catch-all — serve frontend for any unmatched GET
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`WoW M+ Analyzer running on http://localhost:${PORT}`);
});
