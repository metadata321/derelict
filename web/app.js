(function () {
  'use strict';

  var AX = window.AX;
  var $ = function (id) { return document.getElementById(id); };

  var ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
  var ROUTERS = {
    car: ['https://routing.openstreetmap.de/routed-car/route/v1/driving/',
      'https://router.project-osrm.org/route/v1/driving/'],
    foot: ['https://routing.openstreetmap.de/routed-foot/route/v1/driving/'],
    bike: ['https://routing.openstreetmap.de/routed-bike/route/v1/driving/']
  };
  var MAX_SAVED_PLACES = 3000;
  // Public OSM tiles are fine for personal/small use. For a big audience, swap in a
  // provider you have permission to use (see README).
  var TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

  /* ---------- storage ---------- */
  var store = {
    get: function (k, d) {
      try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ }
    }
  };

  var state = {
    xp: Number(store.get('dl_xp', 0)) || 0,
    rejected: new Set(store.get('dl_rejected', [])),
    confirmed: new Set(store.get('dl_confirmed', [])),
    places: new Map(),
    test: !!store.get('dl_test', false),
    radius: Number(store.get('dl_radius', 10000)) || 10000,
    mode: store.get('dl_mode', 'car'),
    me: null,
    target: null,
    addr: {},
    routeToken: 0,
    routeDone: false,
    searching: false
  };
  if (!ROUTERS[state.mode]) state.mode = 'car';
  (store.get('dl_places', []) || []).forEach(function (p) {
    if (p && p.id && typeof p.lat === 'number' && typeof p.lon === 'number') state.places.set(p.id, p);
  });

  function saveProgress() {
    store.set('dl_xp', state.xp);
    store.set('dl_rejected', Array.from(state.rejected));
    store.set('dl_confirmed', Array.from(state.confirmed));
  }
  function savePlaces() {
    var arr = Array.from(state.places.values());
    if (arr.length > MAX_SAVED_PLACES) arr = arr.slice(arr.length - MAX_SAVED_PLACES);
    store.set('dl_places', arr);
  }

  /* ---------- map ---------- */
  var map = L.map('map', { zoomControl: false }).setView([54.0, -2.5], 6);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer(TILE_URL, {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
  }).addTo(map);

  var markers = L.layerGroup().addTo(map);
  var selLayer = L.layerGroup().addTo(map);
  var routeLayer = L.layerGroup().addTo(map);
  var meLayer = L.layerGroup().addTo(map);
  var meDot = null, meRing = null;

  function visiblePlaces() {
    var out = [];
    state.places.forEach(function (p) {
      if (!state.rejected.has(p.id) && !state.confirmed.has(p.id)) out.push(p);
    });
    return out;
  }

  function drawMarkers() {
    markers.clearLayers();
    visiblePlaces().forEach(function (p) {
      var m = L.circleMarker([p.lat, p.lon], {
        radius: 10, color: '#1E2A2F', weight: 2, fillColor: '#F2B705', fillOpacity: 1
      });
      m.on('click', function (e) {
        if (e && e.originalEvent) L.DomEvent.stopPropagation(e);
        selectTarget(p);
      });
      m.addTo(markers);
    });
  }

  function drawSelection() {
    selLayer.clearLayers();
    if (!state.target) return;
    L.circleMarker([state.target.lat, state.target.lon], {
      radius: 18, color: '#A8402F', weight: 4, fill: false, interactive: false
    }).addTo(selLayer);
  }

  function fitToTarget() {
    var p = state.target;
    if (!p) return;
    var pad = {
      paddingTopLeft: [30, 100],
      paddingBottomRight: [30, $('sheet').offsetHeight + 30],
      maxZoom: 17
    };
    if (state.me) map.fitBounds([[state.me.lat, state.me.lon], [p.lat, p.lon]], pad);
    else map.fitBounds([[p.lat - 0.002, p.lon - 0.002], [p.lat + 0.002, p.lon + 0.002]], pad);
  }

  /* ---------- HUD, toast, status ---------- */
  function renderHud() {
    var li = AX.levelInfo(state.xp);
    $('lvlNum').textContent = 'Lv ' + li.level;
    $('lvlTitle').textContent = li.title;
    $('barFill').style.width = Math.min(100, li.pct) + '%';
    $('xpText').textContent = li.into + ' / ' + li.span + ' XP';
    $('bar').setAttribute('aria-valuenow', String(Math.round(li.pct)));
    $('stats').textContent = state.confirmed.size + ' confirmed';
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  function setStatus(msg) { $('status').textContent = msg; }

  function award(n) {
    var before = AX.levelInfo(state.xp).level;
    state.xp += n;
    var after = AX.levelInfo(state.xp);
    saveProgress();
    renderHud();
    if (after.level > before) toast('Level up! You’re now level ' + after.level + ', ' + after.title + '.');
    else toast('+' + n + ' XP');
  }

  /* ---------- OpenStreetMap search ---------- */
  function fetchWithTimeout(url, opts, ms) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, ms);
    opts = opts || {};
    opts.signal = ctrl.signal;
    return fetch(url, opts).then(function (r) { clearTimeout(t); return r; },
      function (e) { clearTimeout(t); throw e; });
  }

  function overpass(lat, lon, radius) {
    var body = 'data=' + encodeURIComponent(AX.buildQuery(lat, lon, radius));
    var chain = Promise.reject(new Error('start'));
    ENDPOINTS.forEach(function (url) {
      chain = chain.catch(function () {
        return fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: body
        }, 35000).then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        });
      });
    });
    return chain;
  }

  function currentCenter() {
    if (state.me) return { lat: state.me.lat, lon: state.me.lon };
    var c = map.getCenter();
    return { lat: c.lat, lon: c.lng };
  }

  function search(lat, lon) {
    if (state.searching) return;
    state.searching = true;
    $('btnSearch').disabled = true;
    setStatus('Searching for abandoned places…');
    overpass(lat, lon, state.radius).then(function (json) {
      var list = AX.parseElements(json);
      var added = 0;
      list.forEach(function (p) {
        if (!state.places.has(p.id)) { state.places.set(p.id, p); added++; }
      });
      savePlaces();
      drawMarkers();
      var left = AX.available(visiblePlaces(), state.rejected, state.confirmed, { lat: lat, lon: lon }, state.radius).length;
      if (!list.length) {
        setStatus('Nothing is mapped as abandoned here. Try a bigger radius or move the map and search again.');
      } else {
        setStatus('Found ' + list.length + ' places (' + added + ' new). ' + left + ' left in your list within ' +
          (state.radius / 1000) + ' km of here.');
      }
    }).catch(function () {
      setStatus('Search failed. Check your connection and try again.');
    }).then(function () {
      state.searching = false;
      $('btnSearch').disabled = false;
    });
  }

  /* ---------- random pick ---------- */
  function randomSpot() {
    var c = currentCenter();
    var list = AX.available(Array.from(state.places.values()), state.rejected, state.confirmed, c, state.radius);
    if (state.target && list.length > 1) {
      list = list.filter(function (p) { return p.id !== state.target.id; });
    }
    var p = AX.pickRandom(list);
    if (!p) {
      if (!state.places.size) setStatus('No places loaded yet. Tap Search this area first.');
      else setStatus('No unchecked places left within ' + (state.radius / 1000) + ' km. Search another area or raise the radius.');
      if (state.target) showHome();
      return;
    }
    selectTarget(p);
  }

  /* ---------- target panel ---------- */
  function showHome() {
    state.target = null;
    state.routeToken++;
    routeLayer.clearLayers();
    drawSelection();
    $('target').hidden = true;
    $('home').hidden = false;
  }

  function coordsText(p) { return p.lat.toFixed(5) + ', ' + p.lon.toFixed(5); }
  function addrText(p) { return state.addr[p.id] || coordsText(p); }
  function distToTarget() {
    if (!state.me || !state.target) return null;
    return AX.haversine(state.me.lat, state.me.lon, state.target.lat, state.target.lon);
  }

  function renderDist() {
    var d = distToTarget();
    $('tDist').textContent = d === null ? 'Waiting for your location…' : AX.formatDist(d) + ' away in a straight line';
  }

  function renderAddr() {
    var p = state.target;
    if (!p) return;
    var a = state.addr[p.id];
    if (a === undefined) $('tAddr').textContent = 'Looking up address…';
    else $('tAddr').textContent = a || ('No street address. Coordinates: ' + coordsText(p));
  }

  function updateCheckin() {
    var p = state.target;
    if (!p) return;
    var d = distToTarget();
    var ok = false, msg;
    if (state.test) { ok = true; msg = 'Test mode is on, so the distance check is skipped.'; }
    else if (d === null) { msg = 'Waiting for your location before you can check in.'; }
    else {
      var slack = Math.min((state.me && state.me.acc) || 0, 100);
      if (Math.max(0, d - slack) <= AX.ON_SITE_M) { ok = true; msg = 'You’re close enough. Is this place really abandoned?'; }
      else msg = 'Get within ' + AX.ON_SITE_M + ' m to check in. You’re ' + AX.formatDist(d) + ' away.';
    }
    $('checkHint').textContent = msg;
    $('btnYes').disabled = !ok;
    $('btnNo').disabled = !ok;
  }

  function reverseGeocode(p) {
    if (state.addr[p.id] !== undefined) return;
    var url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=' +
      p.lat + '&lon=' + p.lon;
    fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } }, 15000)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { state.addr[p.id] = AX.shortAddress(j); })
      .catch(function () { state.addr[p.id] = ''; })
      .then(function () { if (state.target && state.target.id === p.id) renderAddr(); });
  }

  function selectTarget(p) {
    state.target = p;
    state.routeDone = false;
    state.routeToken++;
    routeLayer.clearLayers();
    drawSelection();
    $('home').hidden = true;
    $('target').hidden = false;
    $('tTitle').textContent = p.name || p.kind;
    $('tKind').textContent = p.name ? p.kind : 'Unnamed place on OpenStreetMap';
    var type = p.id.split('/')[0], num = p.id.split('/')[1];
    $('lnkOsm').setAttribute('href', 'https://www.openstreetmap.org/' + type + '/' + encodeURIComponent(num));
    $('lnkGmaps').setAttribute('href', 'https://www.google.com/maps/dir/?api=1&destination=' + p.lat + ',' + p.lon);
    $('routeInfo').textContent = state.me ? 'Loading route…' : 'Waiting for your location to plan a route…';
    $('stepsBox').hidden = true;
    $('steps').textContent = '';
    renderDist();
    renderAddr();
    updateCheckin();
    reverseGeocode(p);
    requestAnimationFrame(fitToTarget);
    if (state.me) loadRoute();
  }

  /* ---------- routing ---------- */
  function fetchRoute(mode, from, to) {
    var coords = from.lon + ',' + from.lat + ';' + to.lon + ',' + to.lat;
    var q = '?overview=full&geometries=geojson&steps=true';
    var chain = Promise.reject(new Error('start'));
    ROUTERS[mode].forEach(function (base) {
      chain = chain.catch(function () {
        return fetchWithTimeout(base + coords + q, {}, 20000).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        }).then(function (j) {
          if (!j || j.code !== 'Ok' || !j.routes || !j.routes.length) throw new Error('no route');
          return j.routes[0];
        });
      });
    });
    return chain;
  }

  function loadRoute() {
    var p = state.target;
    if (!p || !state.me) return;
    state.routeDone = true;
    var token = ++state.routeToken;
    var from = { lat: state.me.lat, lon: state.me.lon };
    $('routeInfo').textContent = 'Loading route…';
    routeLayer.clearLayers();
    fetchRoute(state.mode, from, p).then(function (route) {
      if (token !== state.routeToken) return;
      routeLayer.clearLayers();
      var line = L.geoJSON(route.geometry, { interactive: false });
      line.setStyle({ color: '#1E2A2F', weight: 9, opacity: 0.9 });
      line.addTo(routeLayer);
      L.geoJSON(route.geometry, { interactive: false, style: { color: '#F2B705', weight: 5, opacity: 1 } }).addTo(routeLayer);
      var label = { car: 'driving', foot: 'walking', bike: 'cycling' }[state.mode];
      $('routeInfo').textContent = AX.formatDist(route.distance) + ', about ' + AX.formatDur(route.duration) + ' ' + label + '.';
      var ol = $('steps');
      ol.textContent = '';
      var steps = (route.legs && route.legs[0] && route.legs[0].steps) || [];
      steps.forEach(function (s) {
        var li = document.createElement('li');
        li.textContent = AX.stepText(s) + ' ';
        if (s.distance > 0) {
          var sm = document.createElement('small');
          sm.textContent = '(' + AX.formatDist(s.distance) + ')';
          li.appendChild(sm);
        }
        ol.appendChild(li);
      });
      $('stepsBox').hidden = !steps.length;
    }).catch(function () {
      if (token !== state.routeToken) return;
      routeLayer.clearLayers();
      L.polyline([[from.lat, from.lon], [p.lat, p.lon]], { color: '#A8402F', weight: 4, dashArray: '8 8', interactive: false }).addTo(routeLayer);
      $('routeInfo').textContent = 'Couldn’t load turn-by-turn directions, so the dashed line is a straight line. “Open in maps app” still works.';
      $('stepsBox').hidden = true;
    });
  }

  /* ---------- hand off to the phone's maps app ---------- */
  function openNav() {
    var p = state.target;
    if (!p) return;
    var label = addrText(p).replace(/[()]/g, ' ');
    // geo: URIs open the user's default maps app (or the chooser) on Android
    window.location.href = 'geo:' + p.lat + ',' + p.lon + '?q=' + p.lat + ',' + p.lon + '(' + encodeURIComponent(label) + ')';
  }

  function copyAddr() {
    var p = state.target;
    if (!p) return;
    var text = addrText(p);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Address copied'); },
        function () { toast('Couldn’t copy. Long-press the address to copy it.'); });
    } else toast('Couldn’t copy. Long-press the address to copy it.');
  }

  /* ---------- check-in ---------- */
  function confirmAbandoned() {
    var p = state.target;
    if (!p || $('btnYes').disabled) return;
    state.confirmed.add(p.id);
    award(AX.XP_CONFIRM);
    drawMarkers();
    showHome();
    setStatus('Confirmed. ' + (state.confirmed.size === 1 ? 'That’s your first one.' : state.confirmed.size + ' confirmed so far.') + ' Tap Random spot for the next.');
  }

  function notAbandoned() {
    var p = state.target;
    if (!p || $('btnNo').disabled) return;
    if (!window.confirm('Remove this place from your list for good?')) return;
    state.rejected.add(p.id);
    award(AX.XP_REJECT);
    drawMarkers();
    showHome();
    setStatus('Removed. Thanks for cleaning up the list. Tap Random spot for the next.');
  }

  /* ---------- geolocation ---------- */
  var firstFix = true;
  function onPos(pos) {
    var c = pos.coords;
    state.me = { lat: c.latitude, lon: c.longitude, acc: c.accuracy || 0 };
    if (!meDot) {
      meDot = L.circleMarker([state.me.lat, state.me.lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#1B6FD1', fillOpacity: 1, interactive: false }).addTo(meLayer);
      meRing = L.circle([state.me.lat, state.me.lon], { radius: state.me.acc, color: '#1B6FD1', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(meLayer);
    } else {
      meDot.setLatLng([state.me.lat, state.me.lon]);
      meRing.setLatLng([state.me.lat, state.me.lon]);
      meRing.setRadius(state.me.acc);
    }
    if (firstFix) {
      firstFix = false;
      if (!state.target) map.setView([state.me.lat, state.me.lon], 13);
      search(state.me.lat, state.me.lon);
    }
    if (state.target) {
      renderDist();
      updateCheckin();
      if (!state.routeDone) loadRoute();
    }
  }

  function onGeoErr(err) {
    var msg = err && err.code === 1
      ? 'Location is off. Allow it for this app in Android settings to get routes and check in. You can still browse the map.'
      : 'Can’t get your location yet. Make sure GPS is on. You can still browse the map and search.';
    if (!state.me) setStatus(msg);
    else toast('Lost GPS signal');
  }

  function startGeo() {
    if (!navigator.geolocation) { setStatus('This device doesn’t support location.'); return; }
    navigator.geolocation.watchPosition(onPos, onGeoErr, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  }

  /* ---------- wire up ---------- */
  function setMode(mode) {
    state.mode = mode;
    store.set('dl_mode', mode);
    Array.prototype.forEach.call(document.querySelectorAll('.seg button'), function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-mode') === mode ? 'true' : 'false');
    });
  }

  function init() {
    renderHud();
    drawMarkers();
    setMode(state.mode);
    $('selRadius').value = String(state.radius);
    if (!$('selRadius').value) { $('selRadius').value = '10000'; state.radius = 10000; }
    $('chkTest').checked = state.test;

    $('btnRandom').addEventListener('click', randomSpot);
    $('btnSkip').addEventListener('click', randomSpot);
    $('btnSearch').addEventListener('click', function () { var c = currentCenterForSearch(); search(c.lat, c.lon); });
    $('btnBack').addEventListener('click', function () { showHome(); });
    $('btnNav').addEventListener('click', openNav);
    $('btnCopy').addEventListener('click', copyAddr);
    $('btnYes').addEventListener('click', confirmAbandoned);
    $('btnNo').addEventListener('click', notAbandoned);
    $('selRadius').addEventListener('change', function () {
      state.radius = Number($('selRadius').value) || 10000;
      store.set('dl_radius', state.radius);
      setStatus('Radius set to ' + (state.radius / 1000) + ' km. Tap Search this area to load places.');
    });
    $('chkTest').addEventListener('change', function () {
      state.test = $('chkTest').checked;
      store.set('dl_test', state.test);
      updateCheckin();
    });
    $('btnRestore').addEventListener('click', function () {
      var n = state.rejected.size;
      state.rejected.clear();
      saveProgress();
      drawMarkers();
      toast(n ? 'Restored ' + n + ' places' : 'Nothing to restore');
    });
    Array.prototype.forEach.call(document.querySelectorAll('.seg button'), function (b) {
      b.addEventListener('click', function () {
        setMode(b.getAttribute('data-mode'));
        if (state.target && state.me) loadRoute();
      });
    });

    if ('serviceWorker' in navigator && location.protocol !== 'file:' && navigator.userAgent.indexOf('DerelictApp') === -1) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline cache is optional */ });
    }

    if (store.get('dl_seen', false)) startGeo();
    else {
      $('intro').hidden = false;
      $('btnIntro').addEventListener('click', function () {
        store.set('dl_seen', true);
        $('intro').hidden = true;
        startGeo();
      });
    }
  }

  // Search is centred on the map view so you can look anywhere; random picks stay near you.
  function currentCenterForSearch() {
    var c = map.getCenter();
    return { lat: c.lat, lon: c.lng };
  }

  init();
})();
