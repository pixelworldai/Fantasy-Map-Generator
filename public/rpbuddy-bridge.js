/**
 * RPBuddy ↔ FMG Bridge
 * Injected into Fantasy Map Generator iframe.
 * No-ops when not running inside an iframe.
 * Communicates with RPBuddy parent via postMessage.
 */
(function () {
  "use strict";

  // Only run inside an iframe
  if (window === window.top) return;

  const PARENT = window.parent;
  let clickMode = false;
  let highlightEl = null;

  function send(type, payload) {
    PARENT.postMessage({ type, ...payload }, "*");
  }

  // Log to parent console (bridge logs are in iframe context, invisible to user)
  function parentLog(msg) {
    PARENT.postMessage({ type: "fmg:log", message: msg }, "*");
  }

  // ─── Wait for FMG to be ready ──────────────────────────────
  function waitForReady() {
    const check = setInterval(function () {
      if (
        typeof findCell === "function" &&
        document.getElementById("viewbox") &&
        typeof pack !== "undefined"
      ) {
        clearInterval(check);
        send("fmg:ready", {});
        listen();
      }
    }, 200);
  }

  // ─── Listen for messages from parent ───────────────────────
  function listen() {
    window.addEventListener("message", function (e) {
      var d = e.data;
      if (!d || typeof d.type !== "string") return;

      switch (d.type) {
        case "fmg:load-map":
          loadMap(d.mapFileUrl);
          break;
        case "fmg:request-click":
          enterClickMode();
          break;
        case "fmg:cancel-click":
          exitClickMode();
          break;
        case "fmg:highlight-burg":
          showHighlight(d.x, d.y);
          break;
        case "fmg:clear-highlight":
          clearHighlight();
          break;
        case "fmg:get-cell-data":
          sendCellData(d.x, d.y);
          break;
        case "fmg:show-trail":
          showTrail(d.trail);
          break;
        case "fmg:clear-trail":
          clearTrail();
          break;
        case "fmg:find-route":
          findRoute(d.fromX, d.fromY, d.toX, d.toY);
          break;
        case "fmg:zoom-to":
          zoomToPoint(d.x, d.y, d.z, d.duration);
          break;
        case "fmg:get-world-data":
          sendWorldData();
          break;
        case "fmg:export-map":
          exportMap();
          break;
        case "fmg:regenerate":
          handleRegenerate();
          break;
        case "fmg:lock-ui":
          lockUI();
          break;
        case "fmg:unlock-ui":
          unlockUI();
          break;
      }
    });
  }

  // ─── Load .map file ────────────────────────────────────────
  function loadMap(url) {
    fetch(url)
      .then(function (r) { return r.blob(); })
      .then(function (blob) {
        // FMG's uploadMap expects a blob + callback
        if (typeof uploadMap === "function") {
          uploadMap(blob, function () {
            pollForBurgs();
          });
        }
      })
      .catch(function (err) {
        console.error("[RPBuddy Bridge] Failed to load map:", err);
      });
  }

  // ─── Watabou preview URL generation (uses FMG's own Burgs module) ──
  function getPreviewUrl(b) {
    try {
      if (typeof Burgs !== "undefined" && Burgs.getPreview) {
        var result = Burgs.getPreview(b);
        return result.preview || result.link || null;
      }
    } catch (err) {
      console.error("[RPBuddy Bridge] Preview URL error for burg " + (b.name || b.i) + ":", err);
    }
    return null;
  }

  function pollForBurgs() {
    var attempts = 0;
    var check = setInterval(function () {
      attempts++;
      if (
        typeof pack !== "undefined" &&
        pack.burgs &&
        pack.burgs.length > 1 &&
        typeof Burgs !== "undefined"
      ) {
        clearInterval(check);
        parentLog("[Bridge] Map ready, " + (pack.burgs.length - 1) + " burgs found, Burgs module: " + (typeof Burgs !== "undefined"));

        // Ensure route adjacency map is built for later route-finding
        var routeKeys = pack.cells.routes ? Object.keys(pack.cells.routes).length : 0;
        parentLog("[Bridge] Route network: " + routeKeys + " cells, pack.routes: " + (pack.routes ? pack.routes.length : 0) + " routes");
        if (routeKeys === 0 && pack.routes && typeof Routes !== "undefined" && Routes.buildLinks) {
          try {
            pack.cells.routes = Routes.buildLinks(pack.routes);
            parentLog("[Bridge] Rebuilt route links: " + Object.keys(pack.cells.routes).length + " cells");
          } catch (e) {
            parentLog("[Bridge] Could not build route links: " + e.message);
          }
        }

        var burgs = [];
        var previewCount = 0;
        for (var i = 1; i < pack.burgs.length; i++) {
          var b = pack.burgs[i];
          if (!b || !b.name || b.removed) continue;
          var preview = getPreviewUrl(b);
          if (preview) previewCount++;
          var burgData = {
            i: b.i,
            name: b.name,
            x: b.x,
            y: b.y,
            cell: b.cell,
            state: b.state,
            culture: b.culture,
            capital: b.capital,
            port: b.port,
            population: b.population,
            type: b.type,
            group: b.group || null,
            citadel: b.citadel || 0,
            plaza: b.plaza || 0,
            walls: b.walls || 0,
            shanty: b.shanty || 0,
            temple: b.temple || 0,
            MFCG: b.MFCG || null,
            previewUrl: preview,
          };
          burgs.push(burgData);
        }
        parentLog("[Bridge] Sending " + burgs.length + " burgs (" + previewCount + " with preview URLs)");
        var gw = typeof graphWidth !== "undefined" ? graphWidth : 1920;
        var gh = typeof graphHeight !== "undefined" ? graphHeight : 1080;
        send("fmg:map-loaded", {
          burgs: burgs,
          graphWidth: gw,
          graphHeight: gh,
        });
      }
      if (attempts > 150) {
        clearInterval(check);
        parentLog("[Bridge] Gave up waiting for burgs after 30s (pack: " + (typeof pack !== "undefined") + ", burgs: " + (typeof pack !== "undefined" && pack.burgs ? pack.burgs.length : 0) + ", Burgs: " + (typeof Burgs !== "undefined") + ")");
      }
    }, 200);
  }

  // ─── Click mode ────────────────────────────────────────────
  function enterClickMode() {
    clickMode = true;
    var viewbox = d3.select("#viewbox");
    viewbox.style("cursor", "crosshair");
    viewbox.on("click.rpbuddy", function (event) {
      if (!clickMode) return;
      var point = d3.pointer(event, viewbox.node());
      var x = point[0];
      var y = point[1];
      var cellId = typeof findCell === "function" ? findCell(x, y) : null;
      var burgId = null;
      if (cellId != null && typeof pack !== "undefined" && pack.cells && pack.cells.burg) {
        burgId = pack.cells.burg[cellId] || null;
        if (burgId === 0) burgId = null;
      }
      send("fmg:click", { x: x, y: y, cellId: cellId, burgId: burgId });
      event.stopPropagation();
    });
  }

  function exitClickMode() {
    clickMode = false;
    var viewbox = d3.select("#viewbox");
    viewbox.style("cursor", "");
    viewbox.on("click.rpbuddy", null);
  }

  // ─── Player highlight ──────────────────────────────────────
  function showHighlight(x, y) {
    clearHighlight();
    var svg = document.getElementById("viewbox");
    if (!svg) return;

    var ns = "http://www.w3.org/2000/svg";
    var g = document.createElementNS(ns, "g");
    g.setAttribute("id", "rpbuddy-highlight");

    // Outer pulse ring
    var pulse = document.createElementNS(ns, "circle");
    pulse.setAttribute("cx", x);
    pulse.setAttribute("cy", y);
    pulse.setAttribute("r", "8");
    pulse.setAttribute("fill", "none");
    pulse.setAttribute("stroke", "#f59e0b");
    pulse.setAttribute("stroke-width", "2");
    pulse.setAttribute("opacity", "0.8");

    var anim = document.createElementNS(ns, "animate");
    anim.setAttribute("attributeName", "r");
    anim.setAttribute("from", "6");
    anim.setAttribute("to", "16");
    anim.setAttribute("dur", "1.5s");
    anim.setAttribute("repeatCount", "indefinite");
    pulse.appendChild(anim);

    var animOp = document.createElementNS(ns, "animate");
    animOp.setAttribute("attributeName", "opacity");
    animOp.setAttribute("from", "0.8");
    animOp.setAttribute("to", "0");
    animOp.setAttribute("dur", "1.5s");
    animOp.setAttribute("repeatCount", "indefinite");
    pulse.appendChild(animOp);

    // Inner dot
    var dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);
    dot.setAttribute("r", "4");
    dot.setAttribute("fill", "#f59e0b");

    g.appendChild(pulse);
    g.appendChild(dot);
    svg.appendChild(g);
    highlightEl = g;
  }

  function clearHighlight() {
    if (highlightEl && highlightEl.parentNode) {
      highlightEl.parentNode.removeChild(highlightEl);
    }
    highlightEl = null;
  }

  // ─── Cell data lookup ──────────────────────────────────────
  function sendCellData(x, y) {
    var result = { x: x, y: y };
    try {
      var cellId = typeof findCell === "function" ? findCell(x, y) : null;
      if (cellId == null) {
        send("fmg:cell-data", result);
        return;
      }
      result.cellId = cellId;

      if (typeof pack !== "undefined" && pack.cells) {
        var cells = pack.cells;
        var biomeIdx = cells.biome ? cells.biome[cellId] : null;
        if (biomeIdx != null && typeof biomesData !== "undefined" && biomesData.name) {
          result.biome = biomesData.name[biomeIdx];
        }
        if (cells.state) {
          var stateId = cells.state[cellId];
          if (typeof pack.states !== "undefined" && pack.states[stateId]) {
            result.state = pack.states[stateId].name;
          }
        }
        if (cells.culture) {
          var cultureId = cells.culture[cellId];
          if (typeof pack.cultures !== "undefined" && pack.cultures[cultureId]) {
            result.culture = pack.cultures[cultureId].name;
          }
        }
        if (cells.religion) {
          var religionId = cells.religion[cellId];
          if (typeof pack.religions !== "undefined" && pack.religions[religionId]) {
            result.religion = pack.religions[religionId].name;
          }
        }
        if (cells.province) {
          var provinceId = cells.province[cellId];
          if (typeof pack.provinces !== "undefined" && pack.provinces[provinceId]) {
            result.province = pack.provinces[provinceId].name;
          }
        }
      }

      // Grid-level data
      if (typeof grid !== "undefined" && grid.cells) {
        var gridCellId = typeof findGridCell === "function" ? findGridCell(x, y) : null;
        if (gridCellId != null) {
          if (grid.cells.h) result.elevation = grid.cells.h[gridCellId];
          if (grid.cells.temp) result.temperature = grid.cells.temp[gridCellId];
          if (grid.cells.prec) result.precipitation = grid.cells.prec[gridCellId];
        }
      }
    } catch (err) {
      console.error("[RPBuddy Bridge] Cell data error:", err);
    }
    send("fmg:cell-data", result);
  }

  // ─── Route finding (BFS on route network) ────────────────

  // Find nearest cell that is on the road network (BFS through cell neighbors)
  function findNearestRoadCell(startCell, cellRoutes, maxDepth) {
    if (cellRoutes[startCell]) return startCell;
    if (!pack.cells.c) return null;

    var queue = [startCell];
    var visited = {};
    visited[startCell] = true;
    var depth = {};
    depth[startCell] = 0;

    while (queue.length > 0) {
      var current = queue.shift();
      if (depth[current] >= (maxDepth || 5)) continue;

      var cellNeighbors = pack.cells.c[current];
      if (!cellNeighbors) continue;

      for (var i = 0; i < cellNeighbors.length; i++) {
        var n = cellNeighbors[i];
        if (visited[n]) continue;
        visited[n] = true;
        depth[n] = depth[current] + 1;

        if (cellRoutes[n]) return n;
        queue.push(n);
      }
    }
    return null;
  }

  function findRoute(fromX, fromY, toX, toY) {
    try {
      if (typeof pack === "undefined" || !pack.cells) {
        console.warn("[RPBuddy Bridge] findRoute: pack not available");
        send("fmg:route-found", { found: false });
        return;
      }

      var fromCell = typeof findCell === "function" ? findCell(fromX, fromY) : null;
      var toCell = typeof findCell === "function" ? findCell(toX, toY) : null;
      if (fromCell == null || toCell == null) {
        console.warn("[RPBuddy Bridge] findRoute: could not find cells for coordinates");
        send("fmg:route-found", { found: false });
        return;
      }

      // Ensure route adjacency map exists and is populated
      var cellRoutes = pack.cells.routes;
      if (!cellRoutes || typeof cellRoutes !== "object") {
        cellRoutes = {};
      }
      var routeCount = Object.keys(cellRoutes).length;
      if (routeCount === 0 && pack.routes && typeof Routes !== "undefined" && Routes.buildLinks) {
        console.log("[RPBuddy Bridge] Building route links from pack.routes (" + pack.routes.length + " routes)");
        cellRoutes = Routes.buildLinks(pack.routes);
        pack.cells.routes = cellRoutes;
        routeCount = Object.keys(cellRoutes).length;
      }
      if (routeCount === 0) {
        console.warn("[RPBuddy Bridge] findRoute: no route network available (Routes defined: " + (typeof Routes !== "undefined") + ", pack.routes: " + (pack.routes ? pack.routes.length : "none") + ")");
        send("fmg:route-found", { found: false });
        return;
      }

      // Snap start/end cells to nearest road-connected cells
      var roadFromCell = findNearestRoadCell(fromCell, cellRoutes, 5);
      var roadToCell = findNearestRoadCell(toCell, cellRoutes, 5);
      if (roadFromCell == null || roadToCell == null) {
        console.warn("[RPBuddy Bridge] findRoute: could not snap to road cells (from: " + fromCell + " -> " + roadFromCell + ", to: " + toCell + " -> " + roadToCell + ")");
        send("fmg:route-found", { found: false });
        return;
      }

      console.log("[RPBuddy Bridge] findRoute: from cell " + fromCell + " (road: " + roadFromCell + ") to cell " + toCell + " (road: " + roadToCell + "), network has " + routeCount + " cells");

      // Build route lookup by id for filtering sea routes
      var routeById = {};
      if (pack.routes) {
        for (var r = 0; r < pack.routes.length; r++) {
          routeById[pack.routes[r].i] = pack.routes[r];
        }
      }

      // BFS through route network (skip sea routes)
      var queue = [roadFromCell];
      var visited = {};
      visited[roadFromCell] = true;
      var parent = {};
      parent[roadFromCell] = -1;
      var found = false;

      while (queue.length > 0) {
        var current = queue.shift();
        if (current === roadToCell) {
          found = true;
          break;
        }

        var neighbors = cellRoutes[current];
        if (!neighbors) continue;

        for (var neighbor in neighbors) {
          if (!neighbors.hasOwnProperty(neighbor)) continue;
          var n = Number(neighbor);
          if (visited[n]) continue;

          // Skip sea routes for land travel
          var routeId = neighbors[neighbor];
          var route = routeById[routeId];
          if (route && route.group === "searoutes") continue;

          visited[n] = true;
          parent[n] = current;
          queue.push(n);
        }
      }

      if (!found) {
        console.warn("[RPBuddy Bridge] findRoute: BFS could not find path between road cells " + roadFromCell + " and " + roadToCell);
        send("fmg:route-found", { found: false });
        return;
      }

      // Reconstruct path cells
      var pathCells = [];
      var cell = roadToCell;
      while (cell !== -1) {
        pathCells.unshift(cell);
        cell = parent[cell];
      }

      // Build points: start with actual origin, then route cell centers, then actual destination
      var cells = pack.cells;
      var points = [];
      var totalDist = 0;
      var lastX = fromX;
      var lastY = fromY;

      // Start from actual player position
      points.push({ x: fromX, y: fromY });

      // Add each route cell center
      for (var i = 0; i < pathCells.length; i++) {
        var p = cells.p[pathCells[i]];
        var px = p[0];
        var py = p[1];
        points.push({ x: px, y: py });
        var dx = px - lastX;
        var dy = py - lastY;
        totalDist += Math.sqrt(dx * dx + dy * dy);
        lastX = px;
        lastY = py;
      }

      // End at actual destination position
      points.push({ x: toX, y: toY });
      var edx = toX - lastX;
      var edy = toY - lastY;
      totalDist += Math.sqrt(edx * edx + edy * edy);

      // Convert pixel distance to real-world units
      var dScale = typeof distanceScale !== "undefined" ? distanceScale : 1;
      var dUnit = "mi";
      if (typeof distanceUnitInput !== "undefined" && distanceUnitInput && distanceUnitInput.value) {
        dUnit = distanceUnitInput.value;
      }
      var distance = Math.round(totalDist * dScale * 10) / 10;

      console.log("[RPBuddy Bridge] findRoute: found path with " + points.length + " points, " + distance + " " + dUnit);

      send("fmg:route-found", {
        found: true,
        points: points,
        distance: distance,
        distanceUnit: dUnit,
      });
    } catch (err) {
      console.error("[RPBuddy Bridge] Route finding error:", err);
      send("fmg:route-found", { found: false });
    }
  }

  // ─── Zoom/pan control ─────────────────────────────────────
  function zoomToPoint(x, y, z, duration) {
    if (typeof zoomTo === "function") {
      zoomTo(x, y, z || 8, duration || 1500);
    }
  }

  // ─── Trail rendering ──────────────────────────────────────
  var trailEl = null;

  function showTrail(trail) {
    clearTrail();
    if (!trail || trail.length < 2) return;
    var svg = document.getElementById("viewbox");
    if (!svg) return;

    var ns = "http://www.w3.org/2000/svg";
    var g = document.createElementNS(ns, "g");
    g.setAttribute("id", "rpbuddy-trail");

    // Draw path line
    var points = trail.map(function (p) { return p.x + "," + p.y; }).join(" ");
    var polyline = document.createElementNS(ns, "polyline");
    polyline.setAttribute("points", points);
    polyline.setAttribute("fill", "none");
    polyline.setAttribute("stroke", "#f59e0b");
    polyline.setAttribute("stroke-width", "2");
    polyline.setAttribute("stroke-dasharray", "6,4");
    polyline.setAttribute("stroke-opacity", "0.6");
    polyline.setAttribute("stroke-linecap", "round");
    polyline.setAttribute("stroke-linejoin", "round");
    g.appendChild(polyline);

    // Draw dots at each stop
    for (var i = 0; i < trail.length; i++) {
      var dot = document.createElementNS(ns, "circle");
      dot.setAttribute("cx", trail[i].x);
      dot.setAttribute("cy", trail[i].y);
      dot.setAttribute("r", "2.5");
      dot.setAttribute("fill", "#f59e0b");
      dot.setAttribute("fill-opacity", "0.7");
      g.appendChild(dot);
    }

    svg.appendChild(g);
    trailEl = g;
  }

  function clearTrail() {
    if (trailEl && trailEl.parentNode) {
      trailEl.parentNode.removeChild(trailEl);
    }
    trailEl = null;
  }

  // ─── World Data Extraction ──────────────────────────────────
  function sendWorldData() {
    var result = {};
    try {
      // States
      if (typeof pack !== "undefined" && pack.states) {
        result.states = [];
        for (var i = 1; i < pack.states.length; i++) {
          var s = pack.states[i];
          if (!s || s.removed) continue;
          result.states.push({
            id: s.i,
            name: s.name || "",
            fullName: s.fullName || "",
            form: s.form || "",
            color: s.color || "",
            capital: s.capital || 0,
            provinces: s.provinces ? s.provinces.length : 0,
            urban: s.urban || 0,
            rural: s.rural || 0,
            area: s.area || 0,
            cells: s.cells || 0,
          });
        }
      }
    } catch (e) { result.states = null; }

    try {
      // Cultures
      if (typeof pack !== "undefined" && pack.cultures) {
        result.cultures = [];
        for (var i = 1; i < pack.cultures.length; i++) {
          var c = pack.cultures[i];
          if (!c || c.removed) continue;
          result.cultures.push({
            id: c.i,
            name: c.name || "",
            type: c.type || "",
            base: c.base || 0,
            origins: c.origins || [],
            area: c.area || 0,
            cells: c.cells || 0,
          });
        }
      }
    } catch (e) { result.cultures = null; }

    try {
      // Religions
      if (typeof pack !== "undefined" && pack.religions) {
        result.religions = [];
        for (var i = 1; i < pack.religions.length; i++) {
          var r = pack.religions[i];
          if (!r || r.removed) continue;
          result.religions.push({
            id: r.i,
            name: r.name || "",
            type: r.type || "",
            form: r.form || "",
            deity: r.deity || "",
            origins: r.origins || [],
            area: r.area || 0,
            cells: r.cells || 0,
          });
        }
      }
    } catch (e) { result.religions = null; }

    try {
      // Provinces
      if (typeof pack !== "undefined" && pack.provinces) {
        result.provinces = [];
        for (var i = 1; i < pack.provinces.length; i++) {
          var p = pack.provinces[i];
          if (!p || p.removed) continue;
          result.provinces.push({
            id: p.i,
            name: p.name || "",
            fullName: p.fullName || "",
            stateId: p.state || 0,
            burgId: p.burg || 0,
            area: p.area || 0,
            cells: p.cells || 0,
          });
        }
      }
    } catch (e) { result.provinces = null; }

    try {
      // Rivers
      if (typeof pack !== "undefined" && pack.rivers) {
        result.rivers = [];
        for (var i = 0; i < pack.rivers.length; i++) {
          var rv = pack.rivers[i];
          if (!rv || !rv.name) continue;
          result.rivers.push({
            id: rv.i,
            name: rv.name || "",
            length: rv.length || 0,
            width: rv.width || 0,
            sourceCell: rv.source || 0,
            mouthCell: rv.mouth || 0,
          });
        }
      }
    } catch (e) { result.rivers = null; }

    try {
      // Biomes
      if (typeof biomesData !== "undefined" && biomesData.name) {
        result.biomes = [];
        for (var i = 0; i < biomesData.name.length; i++) {
          result.biomes.push({
            id: i,
            name: biomesData.name[i] || "",
            color: biomesData.color ? biomesData.color[i] || "" : "",
            habitability: biomesData.habitability ? biomesData.habitability[i] || 0 : 0,
          });
        }
      }
    } catch (e) { result.biomes = null; }

    try {
      result.mapSeed = typeof seed !== "undefined" ? seed : null;
      result.populationRate = typeof populationRate !== "undefined" ? populationRate : null;
      result.urbanDensity = typeof urbanDensity !== "undefined" ? urbanDensity : null;
      result.graphWidth = typeof graphWidth !== "undefined" ? graphWidth : null;
      result.graphHeight = typeof graphHeight !== "undefined" ? graphHeight : null;
    } catch (e) { /* ignore */ }

    send("fmg:world-data", result);
  }

  // ─── Export current map data ─────────────────────────────────
  function exportMap() {
    try {
      if (typeof prepareMapData !== "function") {
        parentLog("[Bridge] prepareMapData not available");
        send("fmg:map-exported", { success: false, error: "prepareMapData not available" });
        return;
      }
      var mapData = prepareMapData();

      // Collect burg data (same as pollForBurgs)
      var burgs = [];
      if (typeof pack !== "undefined" && pack.burgs && pack.burgs.length > 1) {
        for (var i = 1; i < pack.burgs.length; i++) {
          var b = pack.burgs[i];
          if (!b || !b.name || b.removed) continue;
          var preview = getPreviewUrl(b);
          burgs.push({
            i: b.i,
            name: b.name,
            x: b.x,
            y: b.y,
            cell: b.cell,
            state: b.state,
            culture: b.culture,
            capital: b.capital,
            port: b.port,
            population: b.population,
            type: b.type,
            group: b.group || null,
            citadel: b.citadel || 0,
            plaza: b.plaza || 0,
            walls: b.walls || 0,
            shanty: b.shanty || 0,
            temple: b.temple || 0,
            MFCG: b.MFCG || null,
            previewUrl: preview,
          });
        }
      }

      var gw = typeof graphWidth !== "undefined" ? graphWidth : 1920;
      var gh = typeof graphHeight !== "undefined" ? graphHeight : 1080;
      parentLog("[Bridge] Export: " + burgs.length + " burgs, mapData length: " + (mapData ? mapData.length : 0));
      send("fmg:map-exported", {
        success: true,
        mapData: mapData,
        burgs: burgs,
        graphWidth: gw,
        graphHeight: gh,
      });
    } catch (err) {
      console.error("[RPBuddy Bridge] Export error:", err);
      send("fmg:map-exported", { success: false, error: err.message });
    }
  }

  // ─── Regenerate map ─────────────────────────────────────────
  function handleRegenerate() {
    try {
      if (typeof regenerateMap === "function") {
        regenerateMap();
        pollForBurgs();
      } else if (typeof generate === "function") {
        generate();
        pollForBurgs();
      } else {
        parentLog("[Bridge] No regenerate function available");
      }
    } catch (err) {
      console.error("[RPBuddy Bridge] Regenerate error:", err);
    }
  }

  // ─── Lock/Unlock FMG UI ────────────────────────────────────
  var lockStyleEl = null;
  var lockDragInterval = null;

  function lockUI() {
    if (lockStyleEl) return;
    var style = document.createElement("style");
    style.id = "rpbuddy-lock-ui";
    // Hide editing toolbar but keep #dialogs (burg info) and #tooltip (hover info)
    style.textContent = "#optionsContainer, #optionsTrigger { display: none !important; }";
    document.head.appendChild(style);
    lockStyleEl = style;

    // Disable burg dragging by removing d3-drag handlers once burgs are rendered
    function disableBurgDrag() {
      if (typeof d3 === "undefined") return false;
      var icons = document.querySelectorAll("#burgIcons > *, #burgLabels > *");
      if (icons.length === 0) return false;
      d3.selectAll("#burgIcons > *").on(".drag", null);
      d3.selectAll("#burgLabels > *").on(".drag", null);
      parentLog("[Bridge] Burg drag disabled (" + icons.length + " elements)");
      return true;
    }
    if (!disableBurgDrag()) {
      lockDragInterval = setInterval(function () {
        if (disableBurgDrag()) clearInterval(lockDragInterval);
      }, 500);
      setTimeout(function () { if (lockDragInterval) clearInterval(lockDragInterval); }, 30000);
    }

    parentLog("[Bridge] UI locked");
  }

  function unlockUI() {
    if (lockStyleEl && lockStyleEl.parentNode) {
      lockStyleEl.parentNode.removeChild(lockStyleEl);
    }
    lockStyleEl = null;
    if (lockDragInterval) {
      clearInterval(lockDragInterval);
      lockDragInterval = null;
    }
    parentLog("[Bridge] UI unlocked");
  }

  // ─── Start ─────────────────────────────────────────────────
  waitForReady();
})();
