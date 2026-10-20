// AI Model Explorer – scatter plot of the Artificial Analysis leaderboard.
// Data comes from aa-data.js (window.AA_DATA), which must be loaded first.
// A model looks like: { name, slug, creator, license, intelligenceEstimated, deprecated,
// firstSeen, lastSeen, [deprecationDate], [retired, retiredDate], <column key>: value, ... }
// Missing values are omitted.

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const { columns: COLUMN_DEFINITIONS, models: MODELS } = window.AA_DATA;

const DEFAULT_X_COLUMN = 'intelligenceIndexCostPerTask';
const DEFAULT_Y_COLUMN = 'intelligenceIndex';
const DEFAULT_TITLE = 'Artificial Analysis Intelligence Index vs Cost per Task';

const STORAGE_KEY = 'aa-plot-state';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

// One color per vendor (extra vendors get generated hues).
const VENDOR_PALETTE = [
  '#d97757', '#10a37f', '#4285f4', '#0866ff', '#7f7f7f', '#ff6900', '#e4572e',
  '#6a4c93', '#2bb3c0', '#1c3d5a', '#8cb33a', '#b5179e', '#f4a259', '#5b8e7d',
  '#c1121f', '#3a86ff', '#9c6644', '#76b900', '#0f62fe', '#ffbe0b', '#06d6a0',
  '#ef476f', '#118ab2', '#8338ec', '#fb5607', '#264653',
];

// Colors for model families in focus mode.
const FAMILY_PALETTE = [
  '#d62728', '#1f77b4', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b',
  '#e377c2', '#bcbd22', '#7f7f7f', '#000075', '#f032e6', '#469990', '#9a6324',
  '#808000', '#4363d8',
];

const THINKING_LEVEL_PATTERN = /^(low|medium|high|xhigh|max|non-reasoning)$/;

// Point radius per thinking level in focus mode.
const LEVEL_RADIUS = {
  low: 5,
  medium: 6.5,
  high: 8,
  xhigh: 9.5,
  max: 11,
};

const DEFAULT_RADIUS = 6.5;
const FOCUS_DEFAULT_RADIUS = 7;
const HOVER_TOLERANCE_PX = 4;

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const byId = (id) => document.getElementById(id);

const plotHost = byId('plot');
const tooltip = byId('tip');
const legend = byId('leg');
const toolbar = byId('bar');
const xSelect = byId('xsel');
const ySelect = byId('ysel');
const xLogCheckbox = byId('xlog');
const yLogCheckbox = byId('ylog');
const focusCheckbox = byId('focussw');
const showOldCheckbox = byId('oldsw');
const resetAxesButton = byId('axreset');
const swapAxesButton = byId('axswap');

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------

const vendors = [...new Set(MODELS.map((row) => row.creator))];

// Families that the user unticked in the legend.
const hiddenFamilies = new Set();

function vendorColor(vendor) {
  const index = vendors.indexOf(vendor);
  if (index < VENDOR_PALETTE.length) {
    return VENDOR_PALETTE[index];
  }
  const hue = (index * 137.5) % 360;
  return `hsl(${hue},55%,45%)`;
}

// Model family = name without the "(effort)" suffix, e.g. "Claude Opus 5.5".
function familyOf(row) {
  return row.name.replace(/\s*\(.*\)\s*$/, '');
}

// Thinking level from the "(effort)" suffix, e.g. "max", or '' when there is none.
function thinkingLevelOf(row) {
  const match = row.name.match(/\(([^)]*)\)\s*$/);
  if (!match) {
    return '';
  }
  const level = match[1].replace(/ with fallback/, '');
  return THINKING_LEVEL_PATTERN.test(level) ? level : '';
}

// Deprecated by the leaderboard, or no longer listed at all.
function isOld(row) {
  return Boolean(row.deprecated || row.retired);
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

function formatNumber(value) {
  return String(+value.toPrecision(3));
}

const FORMATTERS = {
  usd: (value) => '$' + formatNumber(value),
  pct: (value) => formatNumber(value) + '%',
  tok: (value) => (value >= 1e6 ? formatNumber(value / 1e6) + 'M' : formatNumber(value / 1e3) + 'k'),
};

// Column key -> { key, label, group, valueOf(row), format(value) }
const columns = {};
COLUMN_DEFINITIONS.forEach((definition) => {
  columns[definition.key] = {
    key: definition.key,
    label: definition.label,
    group: definition.group,
    valueOf: (row) => row[definition.key] ?? NaN,
    format: FORMATTERS[definition.type] || formatNumber,
  };
});

function formattedValue(row, columnKey) {
  const column = columns[columnKey];
  const value = column.valueOf(row);
  return isNaN(value) ? '--' : column.format(value);
}

function fillColumnSelect(select) {
  const groups = [...new Set(COLUMN_DEFINITIONS.map((definition) => definition.group))];
  groups.forEach((group) => {
    const optionGroup = document.createElement('optgroup');
    optionGroup.label = group;
    COLUMN_DEFINITIONS
      .filter((definition) => definition.group === group)
      .forEach((definition) => optionGroup.appendChild(new Option(definition.label, definition.key)));
    select.appendChild(optionGroup);
  });
}

fillColumnSelect(xSelect);
fillColumnSelect(ySelect);

// ---------------------------------------------------------------------------
// Data source note
// ---------------------------------------------------------------------------

function showDataSource() {
  const link = document.createElement('a');
  link.href = window.AA_DATA.source;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'Artificial Analysis – LLM Leaderboard';
  const note = byId('src');
  note.append('Data: ', link, ` · captured ${window.AA_DATA.capturedAt}`);
}

showDataSource();

// ---------------------------------------------------------------------------
// Legend: one entry per vendor, with a collapsible list of its model families
// ---------------------------------------------------------------------------

// Per vendor: setAll(checked) and refreshFromHidden().
const vendorControls = [];

function buildLegend() {
  legend.innerHTML = '<b>Vendors</b> <button id="all">All</button> <button id="none">None</button>';

  vendors.forEach((vendor) => {
    const families = [...new Set(MODELS.filter((row) => row.creator === vendor).map(familyOf))];
    const hasFamilyList = families.length > 1;

    const vendorBox = document.createElement('div');
    vendorBox.className = 'vend';
    vendorBox.dataset.c = vendor;
    vendorBox.innerHTML =
      `<span class="tg">${hasFamilyList ? '▸' : ''}</span>` +
      `<label><input type="checkbox" checked><i style="background:${vendorColor(vendor)}"></i>${vendor}</label>` +
      '<div class="fams" hidden></div>';

    const toggle = vendorBox.querySelector('.tg');
    const vendorCheckbox = vendorBox.querySelector('input');
    const familyList = vendorBox.querySelector('.fams');

    const familyCheckboxes = families.map((family) => {
      const label = document.createElement('label');
      label.innerHTML = `<input type="checkbox" checked><i class="fs" data-f="${family}"></i>${family}`;
      familyList.appendChild(label);
      const checkbox = label.firstChild;
      checkbox.onchange = () => {
        if (checkbox.checked) {
          hiddenFamilies.delete(family);
        } else {
          hiddenFamilies.add(family);
        }
        syncVendorCheckbox();
        draw();
      };
      return checkbox;
    });

    // Vendor checkbox is checked, unchecked or indeterminate depending on its families.
    function syncVendorCheckbox() {
      const checkedCount = familyCheckboxes.filter((checkbox) => checkbox.checked).length;
      vendorCheckbox.checked = checkedCount > 0;
      vendorCheckbox.indeterminate = checkedCount > 0 && checkedCount < familyCheckboxes.length;
      vendorBox.classList.toggle('off', checkedCount === 0);
      familyCheckboxes.forEach((checkbox) => checkbox.parentNode.classList.toggle('off', !checkbox.checked));
    }

    function setAll(checked) {
      familyCheckboxes.forEach((checkbox, index) => {
        checkbox.checked = checked;
        if (checked) {
          hiddenFamilies.delete(families[index]);
        } else {
          hiddenFamilies.add(families[index]);
        }
      });
      syncVendorCheckbox();
    }

    function refreshFromHidden() {
      familyCheckboxes.forEach((checkbox, index) => {
        checkbox.checked = !hiddenFamilies.has(families[index]);
      });
      syncVendorCheckbox();
    }

    vendorCheckbox.onchange = () => {
      setAll(vendorCheckbox.checked);
      draw();
    };

    if (hasFamilyList) {
      toggle.onclick = () => {
        familyList.hidden = !familyList.hidden;
        toggle.textContent = familyList.hidden ? '▸' : '▾';
        saveState();
      };
    }

    legend.appendChild(vendorBox);
    vendorControls.push({ setAll, refreshFromHidden });
  });

  byId('all').onclick = () => {
    vendorControls.forEach((control) => control.setAll(true));
    draw();
  };

  byId('none').onclick = () => {
    vendorControls.forEach((control) => control.setAll(false));
    draw();
  };
}

buildLegend();

// ---------------------------------------------------------------------------
// Persistent UI state (localStorage). First visit uses the default view.
// Stored fields: x, y (column keys), xl, yl (log scales), f (focus mode),
// r (show retired/deprecated), h (hidden families), o (vendors whose family list is open).
// ---------------------------------------------------------------------------

function vendorBoxes() {
  return [...legend.querySelectorAll('.vend')];
}

function saveState() {
  const state = {
    x: xSelect.value,
    y: ySelect.value,
    xl: xLogCheckbox.checked,
    yl: yLogCheckbox.checked,
    f: focusCheckbox.checked,
    r: showOldCheckbox.checked,
    h: [...hiddenFamilies],
    o: vendorBoxes()
      .filter((box) => !box.querySelector('.fams').hidden)
      .map((box) => box.dataset.c),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    // Storage unavailable (private mode, blocked): state is simply not kept.
  }
}

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch (error) {
    return {};
  }
}

function restoreState() {
  const state = loadState();

  xSelect.value = columns[state.x] ? state.x : DEFAULT_X_COLUMN;
  ySelect.value = columns[state.y] ? state.y : DEFAULT_Y_COLUMN;
  xLogCheckbox.checked = state.xl ?? true;
  yLogCheckbox.checked = state.yl ?? false;
  focusCheckbox.checked = state.f ?? false;
  showOldCheckbox.checked = state.r ?? false;

  vendorControls.forEach((control) => control.setAll(true));
  (state.h || []).forEach((family) => hiddenFamilies.add(family));
  vendorControls.forEach((control) => control.refreshFromHidden());

  const openVendors = Array.isArray(state.o) ? state.o : [];
  vendorBoxes().forEach((box) => {
    const toggle = box.querySelector('.tg');
    if (openVendors.includes(box.dataset.c) && toggle.textContent) {
      toggle.click();
    }
  });
}

function resetAxes() {
  xSelect.value = DEFAULT_X_COLUMN;
  ySelect.value = DEFAULT_Y_COLUMN;
  xLogCheckbox.checked = true;
  yLogCheckbox.checked = false;
  draw();
}

// Exchange X and Y, keeping each column's log setting with it.
function swapAxes() {
  const xColumnKey = xSelect.value;
  const isXLog = xLogCheckbox.checked;
  xSelect.value = ySelect.value;
  xLogCheckbox.checked = yLogCheckbox.checked;
  ySelect.value = xColumnKey;
  yLogCheckbox.checked = isXLog;
  draw();
}

// ---------------------------------------------------------------------------
// Axis scale
// Linear: includes 0 (and negatives). Log: positive range, non-positive values sit at the floor.
// Returns { toPixel(value), ticks }.
// ---------------------------------------------------------------------------

function buildAxis(values, isLog, pixelStart, pixelEnd) {
  const pixelSpan = pixelEnd - pixelStart;
  const maxValue = Math.max(...values, 1e-9);

  if (isLog) {
    const positiveValues = values.filter((value) => value > 0);
    const minPositive = positiveValues.length ? Math.min(...positiveValues) : 1;
    const low = minPositive / 1.6;
    const high = maxValue * 1.6;
    const logLow = Math.log10(low);
    const logHigh = Math.log10(high);

    const ticks = [];
    for (let exponent = Math.floor(logLow); exponent <= Math.ceil(logHigh); exponent++) {
      [1, 3].forEach((multiplier) => {
        const tick = multiplier * 10 ** exponent;
        if (tick >= low && tick <= high) {
          ticks.push(tick);
        }
      });
    }

    const toPixel = (value) => {
      const logValue = Math.log10(Math.max(value, low));
      return pixelStart + (logValue - logLow) / (logHigh - logLow) * pixelSpan;
    };
    return { toPixel, ticks };
  }

  const minValue = Math.min(...values, 0);
  const valueSpan = maxValue - minValue;
  const baseStep = 10 ** Math.floor(Math.log10(valueSpan / 5));
  const step = [1, 2, 5, 10]
    .map((multiplier) => multiplier * baseStep)
    .find((candidate) => valueSpan / candidate <= 8);
  const bottom = Math.floor(minValue / step) * step;
  const top = Math.ceil(maxValue * 1.04 / step) * step;

  const ticks = [];
  for (let tick = bottom; tick <= top + 1e-9; tick += step) {
    ticks.push(+tick.toFixed(10));
  }

  const toPixel = (value) => pixelStart + (value - bottom) / (top - bottom) * pixelSpan;
  return { toPixel, ticks };
}

// ---------------------------------------------------------------------------
// SVG helper
// ---------------------------------------------------------------------------

function svgElement(tagName, attributes, parent) {
  const element = document.createElementNS(SVG_NAMESPACE, tagName);
  Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
  if (parent) {
    parent.appendChild(element);
  }
  return element;
}

function svgText(parent, attributes, text) {
  const element = svgElement('text', attributes, parent);
  element.textContent = text;
  return element;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

// Show only the vendors/families that have data for the chosen columns (data itself is kept).
function updateLegendAvailability(availableRows) {
  const availableFamilies = new Set(availableRows.map(familyOf));
  const availableVendors = new Set(availableRows.map((row) => row.creator));

  vendorBoxes().forEach((box) => {
    box.hidden = !availableVendors.has(box.dataset.c);
  });
  legend.querySelectorAll('.fs').forEach((swatch) => {
    swatch.parentNode.hidden = !availableFamilies.has(swatch.dataset.f);
  });
}

// In focus mode, show each family's color next to its name in the legend.
function updateFamilySwatches(isFocus, familyColor, visibleFamilies) {
  legend.querySelectorAll('.fs').forEach((swatch) => {
    const isShown = isFocus && visibleFamilies.includes(swatch.dataset.f);
    swatch.style.display = isShown ? 'inline-block' : 'none';
    if (isShown) {
      swatch.style.background = familyColor(swatch.dataset.f);
    }
  });
}

function drawAxes(svg, layout, xColumn, yColumn, xAxis, yAxis, isXLog, isYLog) {
  const grid = svgElement('g', { class: 'grid ax' }, svg);
  const plotBottom = layout.top + layout.height;
  const plotRight = layout.left + layout.width;

  xAxis.ticks.forEach((tick) => {
    const x = xAxis.toPixel(tick);
    svgElement('line', { x1: x, x2: x, y1: layout.top, y2: plotBottom }, grid);
    svgText(grid, { x, y: plotBottom + 18, 'text-anchor': 'middle' }, xColumn.format(tick));
  });

  yAxis.ticks.forEach((tick) => {
    const y = yAxis.toPixel(tick);
    svgElement('line', { x1: layout.left, x2: plotRight, y1: y, y2: y }, grid);
    svgText(grid, { x: layout.left - 8, y: y + 4, 'text-anchor': 'end' }, yColumn.format(tick));
  });

  const xTitle = `${xColumn.label} (${isXLog ? 'log' : 'linear'} scale)`;
  const yTitle = `${yColumn.label} (${isYLog ? 'log' : 'linear'} scale)`;
  const axisTitleStyle = { 'text-anchor': 'middle', 'font-size': 13, fill: '#333' };

  svgText(svg, { ...axisTitleStyle, x: layout.left + layout.width / 2, y: innerHeight - 16 }, xTitle);
  svgText(svg, { ...axisTitleStyle, transform: `translate(18,${layout.top + layout.height / 2}) rotate(-90)` }, yTitle);
}

function tooltipEntry(row, xColumn, yColumn) {
  const estimatedNote = row.intelligenceEstimated ? ' (estimated)' : '';
  let html =
    `<b>${row.name}</b><br>` +
    `${row.creator} · ${row.license} · Context ${formattedValue(row, 'contextWindowTokens')}<br>` +
    `Intelligence ${formattedValue(row, DEFAULT_Y_COLUMN)}${estimatedNote}` +
    ` · Cost/task ${formattedValue(row, DEFAULT_X_COLUMN)}` +
    ` · ${formattedValue(row, 'medianOutputTokensPerSecond')} tok/s` +
    ` · First chunk ${formattedValue(row, 'medianTimeToFirstTokenSeconds')} s` +
    ` · Total ${formattedValue(row, 'medianEndToEndResponseTimeSeconds')} s`;

  // Add the plotted columns when they are not already part of the summary.
  const extraColumns = [...new Set([xColumn, yColumn])]
    .filter((column) => column.key !== DEFAULT_X_COLUMN && column.key !== DEFAULT_Y_COLUMN);
  extraColumns.forEach((column) => {
    html += `<br>${column.label}: <b>${formattedValue(row, column.key)}</b>`;
  });
  return html + oldModelCaveat(row);
}

// Status and caveat for a retired or deprecated model ('' for a current one).
function oldModelCaveat(row) {
  if (!isOld(row)) {
    return '';
  }
  const statuses = [];
  if (row.deprecated) {
    statuses.push(`Deprecated (noted ${row.deprecationDate || 'unknown date'})`);
  }
  if (row.retired) {
    statuses.push(`Retired: no longer listed since ${row.retiredDate}`);
  }
  return (
    `<div class="caveat">${statuses.join(' · ')}<br>` +
    `Values as of ${row.lastSeen}. They may not be comparable with current models, ` +
    'as benchmarks and index versions change over time.</div>'
  );
}

function positionTooltip(event) {
  const offset = 14;
  const fitsRight = event.clientX + offset + tooltip.offsetWidth <= innerWidth;
  const left = fitsRight ? event.clientX + offset : event.clientX - tooltip.offsetWidth - offset;
  const top = Math.min(event.clientY + offset, innerHeight - tooltip.offsetHeight - 4);
  tooltip.style.left = Math.max(4, left) + 'px';
  tooltip.style.top = Math.max(4, top) + 'px';
}

// Hover lists every point under/near the cursor, so overlapping points are all readable.
function attachHover(svg, points, xColumn, yColumn) {
  svg.onmousemove = (event) => {
    const bounds = svg.getBoundingClientRect();
    const mouseX = event.clientX - bounds.left;
    const mouseY = event.clientY - bounds.top;

    const hits = points
      .filter((point) => Math.hypot(point.x - mouseX, point.y - mouseY) <= point.radius + HOVER_TOLERANCE_PX)
      .sort((a, b) => yColumn.valueOf(b.row) - yColumn.valueOf(a.row) || xColumn.valueOf(a.row) - xColumn.valueOf(b.row));

    points.forEach((point) => point.circle.classList.toggle('hl', hits.includes(point)));

    if (hits.length === 0) {
      tooltip.style.display = 'none';
      return;
    }

    const header = hits.length > 1
      ? `<div style="opacity:.7;margin-bottom:4px">${hits.length} overlapping models</div>`
      : '';
    const separator = '<hr style="border:0;border-top:1px solid #555;margin:5px 0">';
    tooltip.innerHTML = header + hits.map((point) => tooltipEntry(point.row, xColumn, yColumn)).join(separator);
    tooltip.style.display = 'block';
    positionTooltip(event);
  };

  svg.onmouseleave = () => {
    tooltip.style.display = 'none';
    points.forEach((point) => point.circle.classList.remove('hl'));
  };
}

function draw() {
  saveState();
  plotHost.querySelector('svg')?.remove();

  // Layout: chart sits below the toolbar and left of the legend.
  const toolbarBottom = toolbar.getBoundingClientRect().bottom;
  legend.style.top = toolbarBottom + 8 + 'px';
  legend.style.maxHeight = innerHeight - toolbarBottom - 24 + 'px';

  const margin = { left: 80, right: legend.offsetWidth + 28, top: toolbarBottom + 44, bottom: 60 };
  const layout = {
    left: margin.left,
    top: margin.top,
    width: innerWidth - margin.left - margin.right,
    height: innerHeight - margin.top - margin.bottom,
  };

  const svg = svgElement('svg', { viewBox: `0 0 ${innerWidth} ${innerHeight}` });
  plotHost.prepend(svg);

  const xColumn = columns[xSelect.value] || columns[DEFAULT_X_COLUMN];
  const yColumn = columns[ySelect.value] || columns[DEFAULT_Y_COLUMN];
  const isXLog = xLogCheckbox.checked;
  const isYLog = yLogCheckbox.checked;
  const isFocus = focusCheckbox.checked;
  const showOld = showOldCheckbox.checked;

  // Rows with values for both columns, then those the user did not hide.
  const availableRows = MODELS.filter((row) =>
    (showOld || !isOld(row)) &&
    !isNaN(xColumn.valueOf(row)) &&
    !isNaN(yColumn.valueOf(row)));
  updateLegendAvailability(availableRows);
  const visibleRows = availableRows.filter((row) => !hiddenFamilies.has(familyOf(row)));

  const xAxis = buildAxis(visibleRows.map(xColumn.valueOf), isXLog, layout.left, layout.left + layout.width);
  const yAxis = buildAxis(visibleRows.map(yColumn.valueOf), isYLog, layout.top + layout.height, layout.top);
  const pixelX = (row) => xAxis.toPixel(xColumn.valueOf(row));
  const pixelY = (row) => yAxis.toPixel(yColumn.valueOf(row));

  const isDefaultView = xColumn.key === DEFAULT_X_COLUMN && yColumn.key === DEFAULT_Y_COLUMN;
  const title = isDefaultView ? DEFAULT_TITLE : `${yColumn.label} vs ${xColumn.label}`;
  svgText(svg, {
    x: layout.left + layout.width / 2,
    y: toolbarBottom + 26,
    'text-anchor': 'middle',
    'font-size': 18,
    'font-weight': 600,
    fill: '#222',
  }, title);

  drawAxes(svg, layout, xColumn, yColumn, xAxis, yAxis, isXLog, isYLog);

  // Focus mode: color by model family, link a family's points, label each with its thinking level.
  const visibleFamilies = [...new Set(visibleRows.map(familyOf))];
  const familyColor = (family) => FAMILY_PALETTE[visibleFamilies.indexOf(family) % FAMILY_PALETTE.length];
  updateFamilySwatches(isFocus, familyColor, visibleFamilies);

  if (isFocus) {
    visibleFamilies.forEach((family) => {
      const familyRows = visibleRows
        .filter((row) => familyOf(row) === family)
        .sort((a, b) => xColumn.valueOf(a) - xColumn.valueOf(b));
      if (familyRows.length < 2) {
        return;
      }
      svgElement('polyline', {
        points: familyRows.map((row) => pixelX(row) + ',' + pixelY(row)).join(' '),
        fill: 'none',
        stroke: familyColor(family),
        'stroke-width': 1.5,
        'stroke-opacity': 0.5,
      }, svg);
    });
  }

  const points = [];
  visibleRows.forEach((row) => {
    const x = pixelX(row);
    const y = pixelY(row);
    const level = thinkingLevelOf(row);
    const radius = isFocus ? (LEVEL_RADIUS[level] || FOCUS_DEFAULT_RADIUS) : DEFAULT_RADIUS;
    const fill = isFocus ? familyColor(familyOf(row)) : vendorColor(row.creator);

    const circle = svgElement('circle', { class: 'dot', cx: x, cy: y, r: radius, fill, 'fill-opacity': 0.85 }, svg);

    if (isFocus) {
      // Ring in the vendor color keeps vendors distinguishable.
      circle.style.cssText = `stroke:${vendorColor(row.creator)};stroke-width:3.5`;
      if (level) {
        svgText(svg, { x: x + 10, y: y + 4, 'font-size': 11, fill: '#333', 'pointer-events': 'none' }, level);
      }
    }

    if (isOld(row)) {
      circle.classList.add('old');
      if (!isFocus) {
        // Outline in the point's own color, since the fill is faded.
        circle.style.stroke = fill;
      }
    }

    points.push({ row, circle, x, y, radius });
  });

  attachHover(svg, points, xColumn, yColumn);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

[xSelect, ySelect, xLogCheckbox, yLogCheckbox, focusCheckbox, showOldCheckbox].forEach((control) => {
  control.onchange = draw;
});

resetAxesButton.onclick = resetAxes;
swapAxesButton.onclick = swapAxes;

addEventListener('resize', draw);

// Restore state when the page comes back from the browser's back/forward cache.
addEventListener('pageshow', (event) => {
  if (event.persisted) {
    restoreState();
    draw();
  }
});

restoreState();
draw();
