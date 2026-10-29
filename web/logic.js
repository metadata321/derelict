(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AX = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var XP_CONFIRM = 100;   // confirming a place is abandoned
  var XP_REJECT = 25;     // reporting a place as NOT abandoned (keeps the list clean)
  var ON_SITE_M = 200;    // how close you must be to check in

  var TITLES = ['Scout', 'Wanderer', 'Explorer', 'Tracker', 'Pathfinder',
    'Urbex veteran', 'Ghost hunter', 'Ruin whisperer', 'Legend'];

  // XP needed to reach level n: L1 = 0, L2 = 100, L3 = 300, L4 = 600, ...
  function xpForLevel(n) { return 50 * n * (n - 1); }

  function levelInfo(xp) {
    xp = Math.max(0, Math.floor(xp) || 0);
    var lvl = 1;
    while (xp >= xpForLevel(lvl + 1)) lvl++;
    var base = xpForLevel(lvl);
    var next = xpForLevel(lvl + 1);
    return {
      level: lvl,
      title: TITLES[Math.min(lvl - 1, TITLES.length - 1)],
      into: xp - base,
      span: next - base,
      pct: ((xp - base) / (next - base)) * 100,
      toNext: next - xp
    };
  }

  function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371000, rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function formatDist(m) {
    if (m < 1000) return Math.round(m) + ' m';
    return (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
  }

  function formatDur(s) {
    if (s < 60) return '<1 min';
    var mins = Math.round(s / 60);
    if (mins < 60) return mins + ' min';
    var h = Math.floor(mins / 60), m = mins % 60;
    return h + ' h' + (m ? ' ' + m + ' min' : '');
  }

  // Overpass query: things OpenStreetMap contributors have tagged as abandoned or ruined.
  function buildQuery(lat, lon, radiusM) {
    var a = '(around:' + Math.round(radiusM) + ',' + lat.toFixed(6) + ',' + lon.toFixed(6) + ')';
    return '[out:json][timeout:30];(' +
      'nwr["abandoned"="yes"]' + a + ';' +
      'nwr["building"="ruins"]' + a + ';' +
      'nwr["historic"="ruins"]' + a + ';' +
      'nwr["abandoned:building"]' + a + ';' +
      'nwr["abandoned:amenity"]' + a + ';' +
      'nwr["abandoned:landuse"]' + a + ';' +
      'nwr["disused"="yes"]["building"]' + a + ';' +
      ');out center tags 400;';
  }

  function pretty(s) { return String(s).replace(/_/g, ' '); }

  function kindFor(t) {
    var v;
    if (t['abandoned:amenity']) return 'Abandoned ' + pretty(t['abandoned:amenity']);
    if (t['abandoned:building']) {
      v = t['abandoned:building'];
      return 'Abandoned ' + (v === 'yes' ? 'building' : pretty(v));
    }
    if (t['abandoned:landuse']) return 'Abandoned ' + pretty(t['abandoned:landuse']) + ' land';
    if (t.building === 'ruins') return 'Ruined building';
    if (t.historic === 'ruins') return 'Ruins';
    if (t.abandoned === 'yes') {
      v = t.amenity || t.shop || (t.building && t.building !== 'yes' ? t.building : '') ||
        t.landuse || t.man_made || t.leisure || t.tourism;
      if (v) return 'Abandoned ' + pretty(v);
      return t.building ? 'Abandoned building' : 'Abandoned site';
    }
    if (t.disused === 'yes' && t.building) return 'Disused building';
    return 'Abandoned site';
  }

  function parseElements(json) {
    var out = [], seen = {};
    var els = (json && json.elements) || [];
    els.forEach(function (el) {
      var tags = el.tags || {};
      if (tags.highway || tags.waterway || tags.power) return;
      if (tags.railway && !tags.building && tags.railway !== 'station') return;
      if (el.type !== 'node' && el.type !== 'way' && el.type !== 'relation') return;
      var lat = el.lat, lon = el.lon;
      if ((lat == null || lon == null) && el.center) { lat = el.center.lat; lon = el.center.lon; }
      if (typeof lat !== 'number' || typeof lon !== 'number') return;
      var id = el.type + '/' + el.id;
      if (seen[id]) return;
      seen[id] = true;
      out.push({
        id: id, lat: lat, lon: lon,
        name: String(tags.name || tags['abandoned:name'] || tags.old_name || '').slice(0, 80),
        kind: kindFor(tags)
      });
    });
    return out;
  }

  function available(places, rejected, confirmed, center, radiusM) {
    return places.filter(function (p) {
      if (rejected.has(p.id) || confirmed.has(p.id)) return false;
      if (center && radiusM) return haversine(center.lat, center.lon, p.lat, p.lon) <= radiusM;
      return true;
    });
  }

  function pickRandom(list, rng) {
    if (!list.length) return null;
    var i = Math.floor((rng || Math.random)() * list.length);
    return list[Math.min(i, list.length - 1)];
  }

  // Nominatim reverse-geocode JSON -> short readable address
  function shortAddress(j) {
    if (!j || j.error) return '';
    var a = j.address || {};
    var street = ((a.house_number ? a.house_number + ' ' : '') + (a.road || '')).trim();
    var parts = [street, a.neighbourhood || a.suburb || a.hamlet || a.village,
      a.town || a.city, a.postcode].filter(Boolean);
    if (parts.length >= 2) return parts.join(', ');
    return j.display_name || parts.join(', ');
  }

  // OSRM step -> sentence
  function stepText(step) {
    var m = step.maneuver || {}, mod = m.modifier || '', name = step.name || '';
    var road = name ? ' onto ' + name : '';
    switch (m.type) {
      case 'depart': return 'Head out' + (name ? ' on ' + name : '');
      case 'arrive': return 'Arrive at your destination' + (/left|right/.test(mod) ? ' on the ' + mod.replace(/^(slight|sharp) /, '') : '');
      case 'turn': return 'Turn ' + (mod || 'ahead') + road;
      case 'continue': return 'Continue ' + (!mod || mod === 'straight' ? 'straight' : mod) + road;
      case 'new name': return 'Continue' + road;
      case 'merge': return 'Merge' + (mod ? ' ' + mod : '') + road;
      case 'fork': return 'At the fork, keep ' + (mod || 'ahead') + road;
      case 'end of road': return 'At the end of the road, turn ' + (mod || 'ahead') + road;
      case 'roundabout':
      case 'rotary': return 'At the roundabout, take exit ' + (m.exit || '') + road;
      case 'roundabout turn': return 'At the roundabout, turn ' + (mod || 'ahead') + road;
      case 'on ramp':
      case 'off ramp': return 'Take the ramp' + road;
      default: return 'Continue' + road;
    }
  }

  return {
    XP_CONFIRM: XP_CONFIRM, XP_REJECT: XP_REJECT, ON_SITE_M: ON_SITE_M,
    xpForLevel: xpForLevel, levelInfo: levelInfo, haversine: haversine,
    formatDist: formatDist, formatDur: formatDur, buildQuery: buildQuery,
    kindFor: kindFor, parseElements: parseElements, available: available,
    pickRandom: pickRandom, shortAddress: shortAddress, stepText: stepText
  };
});
