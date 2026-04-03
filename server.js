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

function formatTime(ms) {
  if (!ms) return '?:??';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Rough estimate of max score achievable at a given key level (per dungeon per affix)
function getApproxMaxScore(keyLevel) {
  // Based on RIO scoring: roughly exponential growth per key level
  const base = 38;
  const factor = 1.115;
  return Math.round(base * Math.pow(factor, Math.max(0, keyLevel - 2)));
}

function computeGrade(score, timingRate, dungeonCount) {
  // 0-100 point scale: score (0-65) + timing (0-25) + coverage (0-10)
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
  const { timingRate, depleted, avgKeyLevel } = data;
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

function generateFixes(dungeons, metrics) {
  const fixes = [];
  const depleted = dungeons.filter(d => d.upgrades === 0);
  const bareTimes = dungeons.filter(d => d.upgrades === 1 && d.timePercent > 88);
  const sortedByScore = [...dungeons].sort((a, b) => a.score - b.score);
  const POOL_SIZE = 8;

  // Fix 1: Depleted keys
  if (depleted.length > 0) {
    fixes.push({
      priority: 1,
      title: `Stop Depleting Keys (${depleted.length} dungeon${depleted.length > 1 ? 's' : ''})`,
      description: `Depleted runs in: ${depleted.map(d => d.name).join(', ')}. Depleted keystones score lower and break the stone. Drop 2–3 levels until you're timing consistently, then climb back up.`,
      target: `Action: Run depleted dungeons 2–3 levels lower until timed`
    });
  }

  // Fix 2: Worst dungeon if gap is significant
  if (dungeons.length > 1) {
    const worst = sortedByScore[0];
    const best = sortedByScore[sortedByScore.length - 1];
    const gap = best.score - worst.score;
    if (gap > 40) {
      fixes.push({
        priority: fixes.length + 1,
        title: `Boost Your Weakest: ${worst.name}`,
        description: `${worst.name} at +${worst.keyLevel} is ${gap.toFixed(0)} score behind your best dungeon. Dedicate a session to farming this one — watch a route video, study the skips, and push 2 levels higher.`,
        target: `Current: +${worst.keyLevel} (${worst.score.toFixed(0)} pts) → Target: +${worst.keyLevel + 2}`
      });
    }
  }

  // Fix 3: Missing dungeons
  if (dungeons.length < POOL_SIZE) {
    const missing = POOL_SIZE - dungeons.length;
    fixes.push({
      priority: fixes.length + 1,
      title: `Complete Missing Dungeons (${missing} left)`,
      description: `Every dungeon in the pool contributes to your M+ score. You're leaving free rating on the table. Queue the missing dungeons even at low key levels — any completion counts.`,
      target: `Action: Complete all ${POOL_SIZE} dungeons at +10 or higher`
    });
  }

  // Padding fixes if needed
  if (fixes.length < 3 && bareTimes.length > 0) {
    fixes.push({
      priority: fixes.length + 1,
      title: `Improve Clear Speed`,
      description: `${bareTimes.map(d => d.name).join(', ')} were barely timed (close to the limit). Faster clears = higher upgrades = better score. Focus on skips, CC usage, and bloodlust timing.`,
      target: `Target: +2 upgrade (under 80% of par time) in slow dungeons`
    });
  }

  if (fixes.length < 3 && dungeons.length > 0) {
    const avgLevel = Math.round(dungeons.reduce((s, d) => s + d.keyLevel, 0) / dungeons.length);
    fixes.push({
      priority: fixes.length + 1,
      title: `Push Higher Key Levels`,
      description: `You're timing your current range well. Each key level adds ~15–20 points per dungeon. Start pushing 2–3 levels above your current best to build score momentum.`,
      target: `Target: Push to +${avgLevel + 3} in your top 2–3 dungeons`
    });
  }

  while (fixes.length < 3) {
    fixes.push({
      priority: fixes.length + 1,
      title: `Maintain Consistency`,
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

async function fetchWCL(name, realm, region) {
  const realmSlug = realmToSlug(realm);
  const url = `https://www.warcraftlogs.com/character/${region.toLowerCase()}/${realmSlug}/${name.toLowerCase()}`;

  const response = await axios.get(url, {
    headers: BROWSER_HEADERS,
    timeout: 12000,
    maxRedirects: 5
  });

  const $ = cheerio.load(response.data);
  const nextDataText = $('#__NEXT_DATA__').html();
  if (!nextDataText) return null;

  const nextData = JSON.parse(nextDataText);
  const pageProps = nextData?.props?.pageProps;
  if (!pageProps) return null;

  // WCL page structure varies — best-effort extraction of parse data
  const character = pageProps.character || pageProps.characterData?.character;
  if (!character) return null;

  // Look for any M+ or DPS ranking data
  const rankings = character.mythicPlusRankings
    || character.zoneRankings
    || character.encounterRankings
    || null;

  if (!rankings) return null;

  return {
    parses: rankings,
    wclUrl: `https://www.warcraftlogs.com/character/${region.toLowerCase()}/${realmSlug}/${name.toLowerCase()}`
  };
}

function processBestRuns(bestRuns, alternateRuns) {
  // Merge best + alternate runs, keep highest-scoring run per dungeon
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
      url: run.url || null
    };
  }).sort((a, b) => b.score - a.score);
}

app.post('/api/analyze', async (req, res) => {
  const { characterName, server, region } = req.body || {};

  if (!characterName || !server || !region) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: characterName, server, region'
    });
  }

  try {
    // Primary: Raider.IO
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

    // Secondary: WCL (best effort — never blocks the response)
    let wclData = null;
    try {
      wclData = await fetchWCL(characterName, server, region);
    } catch (_e) {
      // Non-critical — proceed without WCL data
    }

    // Process runs
    const dungeons = processBestRuns(rioData.mythic_plus_best_runs, rioData.mythic_plus_alternate_runs);

    // Score metrics
    const scores = rioData.mythic_plus_scores_by_season?.current || {};
    const overallScore = scores.all || 0;

    const timedRuns = dungeons.filter(d => d.upgrades > 0);
    const timingRate = dungeons.length > 0 ? timedRuns.length / dungeons.length : 0;
    const depleted = dungeons.filter(d => d.upgrades === 0).length;
    const avgKeyLevel = dungeons.length > 0
      ? dungeons.reduce((s, d) => s + d.keyLevel, 0) / dungeons.length
      : 0;

    // Score efficiency: how close each dungeon score is to estimated max at that key level
    const scoreEfficiency = dungeons.length > 0
      ? dungeons.reduce((sum, d) => {
          const estMax = getApproxMaxScore(d.keyLevel);
          return sum + Math.min(100, (d.score / estMax) * 100);
        }, 0) / dungeons.length
      : 0;

    const grade = computeGrade(overallScore, timingRate, dungeons.length);
    const gradeCtx = { timingRate, depleted, avgKeyLevel, score: overallScore };
    const gradeDescription = getGradeDescription(grade, gradeCtx);
    const fixes = generateFixes(dungeons, gradeCtx);

    // Estimated max scores per dungeon (for chart comparison)
    const dungeonsWithMax = dungeons.map(d => ({
      ...d,
      estimatedMaxScore: parseFloat((getApproxMaxScore(d.keyLevel) * 1.08).toFixed(1))
    }));

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
            depleted,
            avgKeyLevel: parseFloat(avgKeyLevel.toFixed(1)),
            scoreEfficiency: parseFloat(scoreEfficiency.toFixed(1)),
            rankWorld: rioData.mythic_plus_ranking?.world || null,
            rankRegion: rioData.mythic_plus_ranking?.region || null,
            rankRealm: rioData.mythic_plus_ranking?.realm || null
          }
        },
        dungeons: dungeonsWithMax,
        fixes,
        wclData: wclData || null
      }
    });

  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Catch-all — serve frontend for any unmatched GET
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`WoW M+ Analyzer running on http://localhost:${PORT}`);
});
