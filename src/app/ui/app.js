import { en, resolveLocale, zhCN } from "./i18n.js";

const localePreferenceKey = "corvex-ops-locale";
const browserLanguages = [...(window.navigator.languages ?? []), window.navigator.language ?? ""];

function readSavedLocale() {
  try {
    return window.localStorage.getItem(localePreferenceKey) ?? "";
  } catch (error) {
    window.console.warn("read operations UI language preference failed", error);
    return "";
  }
}

let locale = resolveLocale(readSavedLocale(), browserLanguages);
let copy = locale === "zh-CN" ? zhCN : en;
const app = document.querySelector("#app");
const updated = document.querySelector("#updated");
const languageSelect = document.querySelector("#language");
const statuses = [
  "queued",
  "preparing",
  "analyzing",
  "fixing",
  "verifying",
  "publishing",
  "completed",
  "failed",
  "stale",
  "cancelled",
];
const queue = { status: "", type: "", search: "", offset: 0 };
// 丢弃较早请求的响应，避免慢响应覆盖用户刚切换到的新页面。
let renderVersion = 0;
let traceViewState;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function append(parent, ...children) {
  for (const child of children) parent.append(child);
  return parent;
}

function panel(title, body) {
  const section = element("section", undefined, "panel");
  append(section, element("div", title, "panel-title"), append(element("div", undefined, "panel-body"), body));
  return section;
}

function formatDate(value) {
  if (!value) return copy.none;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? copy.invalidDate : date.toLocaleString(locale);
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return copy.none;
  if (seconds < 60) return copy.durationSecondsTemplate.replace("{value}", String(seconds));
  if (seconds < 3600) {
    return copy.durationMinutesTemplate
      .replace("{minutes}", String(Math.floor(seconds / 60)))
      .replace("{seconds}", String(seconds % 60));
  }
  return copy.durationHoursTemplate
    .replace("{hours}", String(Math.floor(seconds / 3600)))
    .replace("{minutes}", String(Math.floor((seconds % 3600) / 60)));
}

function formatTraceDuration(durationMs) {
  if (durationMs === null || durationMs === undefined) return copy.none;
  if (durationMs < 1000) {
    return copy.traceDurationMsTemplate.replace("{value}", String(Math.round(durationMs)));
  }
  return formatDuration(Math.floor(durationMs / 1000));
}

function elapsedSince(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? formatDuration(Math.max(0, Math.floor((Date.now() - timestamp) / 1000)))
    : copy.invalidDate;
}

function setUpdated(value) {
  updated.textContent = value ? copy.updatedTemplate.replace("{value}", formatDate(value)) : "";
}

async function api(path) {
  const response = await fetch(path, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      copy.requestFailedTemplate
        .replace("{status}", String(response.status))
        .replace("{message}", body.trim() || response.statusText),
    );
  }
  return response.json();
}

function showError(error) {
  app.replaceChildren(element("div", error instanceof Error ? error.message : String(error), "error"));
}

function statCard(label, value, note = "") {
  const card = element("section", undefined, "card");
  append(card, element("div", label, "card-label"), element("div", value, "card-value"));
  if (note) card.append(element("div", note, "card-note"));
  return card;
}

function heading(title, description, action) {
  const section = element("div", undefined, "page-heading");
  const titleGroup = element("div");
  append(titleGroup, element("h1", title));
  if (description) titleGroup.append(element("p", description));
  section.append(titleGroup);
  if (action) section.append(action);
  return section;
}

function table(headers, rows) {
  const wrapper = element("div", undefined, "table-wrap");
  const tableNode = element("table");
  const head = element("thead");
  const headerRow = element("tr");
  for (const value of headers) headerRow.append(element("th", value));
  head.append(headerRow);
  const body = element("tbody");
  for (const row of rows) body.append(row);
  tableNode.append(head, body);
  wrapper.append(tableNode);
  return wrapper;
}

function statusBadge(status) {
  return element("span", copy.statuses[status] ?? status, `badge ${status}`);
}

function overviewRow(label, value) {
  const item = element("div", undefined, "status-item");
  return append(item, element("span", label), element("strong", value));
}

async function renderOverview(version) {
  const data = await api("/api/ops/overview");
  if (version !== renderVersion) return;
  setUpdated(data.generatedAt);
  const active = ["preparing", "analyzing", "fixing", "verifying", "publishing"]
    .reduce((sum, status) => sum + data.counts[status], 0);
  const cards = element("div", undefined, "cards");
  append(
    cards,
    statCard(
      copy.queuedTitle,
      data.counts.queued,
      copy.oldestWaitingTemplate.replace("{value}", formatDuration(data.oldestQueueAgeSeconds)),
    ),
    statCard(copy.inProgressTitle, active, copy.activeStages),
    statCard(copy.failedTitle, data.counts.failed, copy.requiresReview),
    statCard(
      copy.workersOnline,
      data.workers.onlineCount,
      copy.lastSeenTemplate.replace("{value}", formatDate(data.workers.lastSeenAt)),
    ),
  );
  const statusGrid = element("div", undefined, "status-grid");
  for (const status of statuses) {
    statusGrid.append(overviewRow(copy.statuses[status], data.counts[status]));
  }
  const metricsRows = data.modelCalls.map((metric) => {
    const row = element("tr");
    append(
      row,
      element("td", copy.types[metric.taskType] ?? metric.taskType),
      element("td", copy.outcomes[metric.outcome] ?? metric.outcome),
      element("td", metric.calls),
      element("td", copy.metricDurationTemplate.replace("{value}", (metric.durationMs / 1000).toFixed(1))),
      element("td", metric.inputTokens),
      element("td", metric.outputTokens),
    );
    return row;
  });
  const metrics = metricsRows.length
    ? table([copy.task, copy.outcome, copy.calls, copy.duration, copy.inputTokens, copy.outputTokens], metricsRows)
    : element("p", copy.noModelCalls, "muted");
  const refresh = element("button", copy.refresh, "primary");
  refresh.addEventListener("click", render);
  app.replaceChildren(
    heading(copy.overviewTitle, copy.overviewDescription, refresh),
    cards,
    panel(copy.lifecycle, statusGrid),
    panel(copy.modelUsage, metrics),
  );
}

function addFilter(select, label, allLabel, values, selected) {
  const field = element("label", undefined, "field");
  field.append(element("span", label));
  const control = element("select");
  const all = element("option", allLabel);
  all.value = "";
  control.append(all);
  for (const [value, text] of values) {
    const option = element("option", text);
    option.value = value;
    control.append(option);
  }
  control.value = selected;
  field.append(control);
  select.push(control);
  return field;
}

async function renderJobs(version) {
  const params = new URLSearchParams({ limit: "25", offset: String(queue.offset) });
  if (queue.status) params.set("status", queue.status);
  if (queue.type) params.set("type", queue.type);
  if (queue.search) params.set("search", queue.search);
  const data = await api(`/api/ops/jobs?${params}`);
  if (version !== renderVersion) return;
  setUpdated(new Date().toISOString());

  const filters = element("form", undefined, "filters");
  const statusSelect = [];
  const typeSelect = [];
  filters.append(
    addFilter(
      statusSelect,
      copy.statusFilter,
      copy.allStatuses,
      statuses.map((status) => [status, copy.statuses[status]]),
      queue.status,
    ),
    addFilter(
      typeSelect,
      copy.typeFilter,
      copy.allTypes,
      [["review", copy.types.review], ["fix", copy.types.fix], ["explain", copy.types.explain]],
      queue.type,
    ),
  );
  const searchField = element("label", undefined, "field");
  searchField.append(element("span", copy.searchLabel));
  const searchInput = element("input");
  searchInput.type = "search";
  searchInput.maxLength = 100;
  searchInput.value = queue.search;
  searchInput.placeholder = copy.searchPlaceholder;
  searchField.append(searchInput);
  filters.append(searchField);
  const submit = element("button", copy.applyFilters, "primary");
  filters.append(submit);
  filters.addEventListener("submit", (event) => {
    event.preventDefault();
    queue.status = statusSelect[0].value;
    queue.type = typeSelect[0].value;
    queue.search = searchInput.value.trim();
    queue.offset = 0;
    render();
  });

  const rows = data.items.map((job) => {
    const row = element("tr");
    const id = element("a", job.id);
    id.href = `#jobs/${encodeURIComponent(job.id)}`;
    append(
      row,
      append(element("td"), statusBadge(job.status)),
      element("td", copy.types[job.type] ?? job.type),
      element("td", `${job.projectId}:${job.mrIid}`),
      append(element("td"), id),
      element("td", formatDate(job.createdAt)),
      element("td", elapsedSince(job.createdAt)),
      element("td", `${job.attemptCount}`),
      element("td", formatDate(job.updatedAt)),
    );
    return row;
  });
  const content = data.items.length
    ? table(
        [
          copy.statusFilter,
          copy.typeFilter,
          copy.projectMr,
          copy.jobId,
          copy.created,
          copy.age,
          copy.attempts,
          copy.updated,
        ],
        rows,
      )
    : element("div", copy.noMatchingJobs, "empty");
  const pagination = element("div", undefined, "pagination");
  const start = data.total === 0 ? 0 : queue.offset + 1;
  const end = Math.min(queue.offset + data.items.length, data.total);
  pagination.append(
    element(
      "span",
      copy.showingTemplate
        .replace("{start}", String(start))
        .replace("{end}", String(end))
        .replace("{total}", String(data.total)),
    ),
  );
  const buttons = element("div");
  const previous = element("button", copy.previous);
  previous.disabled = queue.offset === 0;
  previous.addEventListener("click", () => {
    queue.offset = Math.max(0, queue.offset - 25);
    render();
  });
  const next = element("button", copy.next);
  next.disabled = queue.offset + data.items.length >= data.total;
  next.addEventListener("click", () => {
    queue.offset += 25;
    render();
  });
  buttons.append(previous, next);
  pagination.append(buttons);
  const tablePanel = element("section", undefined, "panel");
  tablePanel.append(filters, content, pagination);
  const refresh = element("button", copy.refresh);
  refresh.addEventListener("click", render);
  app.replaceChildren(heading(copy.jobsTitle, copy.jobsDescription, refresh), tablePanel);
}

function detailItem(list, label, value, className = "") {
  const item = element("div", undefined, "detail-item");
  const definition = element("dd", value ?? copy.none, className);
  append(item, element("dt", label), definition);
  list.append(item);
}

function detailNodeItem(list, label, value) {
  const item = element("div", undefined, "detail-item");
  const definition = element("dd");
  definition.append(value);
  append(item, element("dt", label), definition);
  list.append(item);
}

function expandableText(value, label, className = "") {
  const details = element("details", undefined, className);
  const summary = element("summary");
  append(summary, element("span", label), element("span", value.split("\n", 1)[0], "details-preview"));
  append(details, summary, element("pre", value, "details-content"));
  return details;
}

function traceField(label, value, emptyLabel) {
  return value
    ? expandableText(value, label, "trace-payload")
    : append(element("div", undefined, "trace-payload trace-payload-empty"), element("span", label), element("span", emptyLabel));
}

function createTraceExperience(entries, jobId) {
  if (!traceViewState || traceViewState.jobId !== jobId) {
    traceViewState = {
      jobId,
      selectedIds: null,
      activeTab: "overview",
      eventListScrollTop: 0,
      expandedDetails: [],
    };
  }
  if (entries.length === 0) return element("div", copy.noTrajectory, "empty");

  const traces = [...entries].sort((left, right) => {
    const timeDifference = Date.parse(left.startedAt) - Date.parse(right.startedAt);
    return timeDifference || left.id - right.id;
  });
  const startTime = Math.min(...traces.map((entry) => Date.parse(entry.startedAt)));
  const endTime = Math.max(...traces.map((entry) => Date.parse(entry.finishedAt ?? entry.startedAt)));
  const duration = Math.max(1, endTime - startTime);
  const basePlotWidth = Math.max(760, Math.min(1400, traces.length * 22));
  const experience = element("div", undefined, "trace-experience");
  const overview = element("section", undefined, "trace-overview");
  const overviewTitle = element("strong", copy.traceOverview, "trace-overview-title");
  const overviewSummary = element(
    "span",
    copy.traceOverviewSummaryTemplate
      .replace("{events}", String(traces.length))
      .replace("{duration}", formatTraceDuration(duration)),
    "trace-overview-summary",
  );
  const zoomOut = element("button", "−", "trace-zoom-button");
  const zoomIn = element("button", "+", "trace-zoom-button");
  const zoomReset = element("button", copy.traceZoomReset, "trace-zoom-reset");
  const zoomValue = element("span", "100%", "trace-zoom-value");
  zoomOut.type = "button";
  zoomIn.type = "button";
  zoomReset.type = "button";
  zoomOut.setAttribute("aria-label", copy.traceZoomOut);
  zoomIn.setAttribute("aria-label", copy.traceZoomIn);
  zoomOut.title = copy.traceZoomOut;
  zoomIn.title = copy.traceZoomIn;
  const overviewControls = append(element("div", undefined, "trace-overview-controls"), zoomOut, zoomValue, zoomIn, zoomReset);
  const overviewHeader = append(element("div", undefined, "trace-overview-header"), overviewTitle, overviewSummary, overviewControls);
  const overviewScroll = element("div", undefined, "trace-overview-scroll");
  const scene = element("div", undefined, "trace-overview-scene");
  scene.setAttribute("aria-label", copy.traceDiagram);
  const labelWidth = 72;
  const axis = element("div", undefined, "trace-overview-axis-row");
  axis.append(element("span", undefined, "trace-overview-label-spacer"));
  const axisPlot = element("div", undefined, "trace-overview-axis");
  for (let index = 0; index <= 4; index += 1) {
    const ratio = index / 4;
    const tick = element("span", formatTraceDuration(Math.round(duration * ratio)), "trace-overview-tick");
    tick.style.left = `${ratio * 100}%`;
    axisPlot.append(tick);
  }
  axis.append(axisPlot);
  scene.append(axis);

  const plots = new Map();
  for (const kind of ["llm", "tool"]) {
    const row = element("div", undefined, `trace-overview-track trace-overview-track-${kind}`);
    row.append(element("span", copy.traceKinds[kind], "trace-overview-track-label"));
    const plot = element("div", undefined, `trace-overview-plot trace-overview-plot-${kind}`);
    row.append(plot);
    scene.append(row);
    plots.set(kind, plot);
  }

  const selectionBox = element("div", undefined, "trace-overview-selection");
  selectionBox.hidden = true;
  scene.append(selectionBox);
  const bars = new Map();
  for (const entry of traces) {
    const startRatio = Math.max(0, (Date.parse(entry.startedAt) - startTime) / duration);
    const endRatio = Math.max(startRatio, (Date.parse(entry.finishedAt ?? entry.startedAt) - startTime) / duration);
    const bar = element("button", undefined, `trace-time-bar trace-time-bar-${entry.kind} trace-time-bar-${entry.status}`);
    const title = entry.kind === "llm" ? entry.model || entry.name : entry.name;
    bar.type = "button";
    bar.title = `${title} · ${formatTraceDuration(entry.durationMs)}`;
    bar.setAttribute("aria-label", `${copy.traceKinds[entry.kind]}: ${title}, ${formatTraceDuration(entry.durationMs)}`);
    bar.dataset.traceId = String(entry.id);
    plots.get(entry.kind).append(bar);
    bars.set(entry.id, { bar, startRatio, widthRatio: endRatio - startRatio });
    bar.addEventListener("click", () => setSelection(new Set([entry.id])));
  }
  overviewScroll.append(scene);

  let zoom = 1;
  const updateZoom = () => {
    const plotWidth = Math.round(basePlotWidth * zoom);
    scene.style.width = `${labelWidth + plotWidth}px`;
    axisPlot.style.width = `${plotWidth}px`;
    for (const plot of plots.values()) plot.style.width = `${plotWidth}px`;
    for (const { bar, startRatio, widthRatio } of bars.values()) {
      bar.style.left = `${startRatio * plotWidth}px`;
      bar.style.width = `${Math.max(4, widthRatio * plotWidth)}px`;
    }
    zoomValue.textContent = `${Math.round(zoom * 100)}%`;
  };
  zoomOut.addEventListener("click", () => {
    zoom = Math.max(0.5, zoom / 1.25);
    updateZoom();
  });
  zoomIn.addEventListener("click", () => {
    zoom = Math.min(4, zoom * 1.25);
    updateZoom();
  });
  zoomReset.addEventListener("click", () => {
    zoom = 1;
    updateZoom();
  });
  updateZoom();

  const selectionStatus = element("span", copy.traceSelectionHint, "trace-selection-status");
  const clearSelection = element("button", copy.traceClearSelection, "trace-clear-selection");
  clearSelection.type = "button";
  clearSelection.hidden = true;
  const selectionToolbar = append(element("div", undefined, "trace-selection-toolbar"), selectionStatus, clearSelection);

  const workbench = element("div", undefined, "trace-workbench");
  const eventPane = element("section", undefined, "trace-events-pane");
  const eventHeading = append(
    element("div", undefined, "trace-pane-heading"),
    element("strong", copy.traceRecords),
    element("span", String(traces.length), "trace-event-count"),
  );
  const eventList = element("div", undefined, "trace-event-list");
  eventList.setAttribute("aria-label", copy.traceRecords);
  const eventButtons = new Map();
  for (const entry of traces) {
    const row = element("button", undefined, `trace-event-row trace-event-row-${entry.kind}`);
    const title = entry.kind === "llm" ? entry.model || copy.traceAgent : entry.name;
    const round = copy.traceAttemptRoundTemplate
      .replace("{attempt}", String(entry.attempt))
      .replace("{round}", entry.round === null ? copy.traceRoundUnknown : String(entry.round));
    row.type = "button";
    row.setAttribute("aria-pressed", "false");
    row.append(
      element("span", copy.traceKinds[entry.kind], "trace-event-kind"),
      element("strong", title, "trace-event-title"),
      element("span", round, "trace-event-round"),
      element("span", copy.traceStatuses[entry.status] ?? entry.status, `trace-event-status trace-event-status-${entry.status}`),
      element("time", formatTraceDuration(entry.durationMs), "trace-event-duration"),
    );
    row.addEventListener("click", () => setSelection(new Set([entry.id])));
    eventList.append(row);
    eventButtons.set(entry.id, row);
  }
  eventPane.append(eventHeading, eventList);

  const inspector = element("section", undefined, "trace-inspector");
  const inspectorHeading = element("strong", copy.traceInspector, "trace-pane-heading");
  const tabList = element("div", undefined, "trace-inspector-tabs");
  tabList.setAttribute("role", "tablist");
  const inspectorContent = element("div", undefined, "trace-inspector-content");
  inspectorContent.setAttribute("role", "tabpanel");
  const tabs = [
    ["overview", copy.traceTabOverview],
    ["parameters", copy.traceTabParameters],
    ["result", copy.traceTabResult],
    ["schema", copy.traceTabSchema],
    ["timing", copy.traceTabTiming],
  ];
  let activeTab = tabs.some(([id]) => id === traceViewState.activeTab)
    ? traceViewState.activeTab
    : "overview";

  const renderInspector = () => {
    const selected = traces.filter((entry) => selectedIds.has(entry.id));
    inspectorContent.replaceChildren();
    if (selected.length === 0) {
      inspectorContent.append(element("div", copy.traceNoSelection, "trace-inspector-empty"));
      return;
    }
    if (selected.length > 1) {
      const details = element("dl", undefined, "trace-inspector-grid");
      detailItem(details, copy.traceSelectedCountTemplate.replace("{count}", String(selected.length)), selected.length);
      detailItem(details, copy.traceDuration, formatTraceDuration(selected.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0)));
      detailItem(details, copy.traceStatus, `${selected.filter((entry) => entry.status === "succeeded").length} / ${selected.length}`);
      inspectorContent.append(details);
      return;
    }

    const entry = selected[0];
    if (activeTab === "overview") {
      const details = element("dl", undefined, "trace-inspector-grid");
      detailItem(details, copy.traceKinds[entry.kind], entry.kind === "llm" ? entry.model || entry.name : entry.name);
      detailItem(details, copy.traceStatus, copy.traceStatuses[entry.status] ?? entry.status);
      detailItem(details, copy.traceAttempt, entry.attempt);
      detailItem(details, copy.traceRoundTemplate.replace("{round}", entry.round ?? copy.traceRoundUnknown), entry.round ?? copy.traceRoundUnknown);
      detailItem(details, copy.traceDuration, formatTraceDuration(entry.durationMs));
      if (entry.kind === "llm") {
        detailItem(details, copy.inputTokens, entry.inputTokens ?? copy.none);
        detailItem(details, copy.outputTokens, entry.outputTokens ?? copy.none);
      }
      inspectorContent.append(details);
    } else if (activeTab === "parameters") {
      inspectorContent.append(traceField(
        entry.kind === "llm" ? copy.traceInput : copy.traceArguments,
        entry.input ?? entry.rawContent,
        copy.traceNoInput,
      ));
    } else if (activeTab === "result") {
      inspectorContent.append(traceField(copy.traceResult, entry.output, copy.traceNoOutput));
      if (entry.errorDetail) inspectorContent.append(traceField(copy.error, entry.errorDetail, copy.traceNoOutput));
    } else if (activeTab === "schema") {
      inspectorContent.append(traceField(copy.traceSchema, entry.schema, copy.noRawContent));
    } else {
      const details = element("dl", undefined, "trace-inspector-grid");
      detailItem(details, copy.started, formatDate(entry.startedAt));
      detailItem(details, copy.finished, formatDate(entry.finishedAt));
      detailItem(details, copy.traceDuration, formatTraceDuration(entry.durationMs));
      inspectorContent.append(details);
    }
  };
  const tabButtons = new Map();
  for (const [id, label] of tabs) {
    const button = element("button", label, "trace-inspector-tab");
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(activeTab === id));
    button.addEventListener("click", () => {
      activeTab = id;
      traceViewState.activeTab = activeTab;
      for (const [tabId, tabButton] of tabButtons) {
        tabButton.setAttribute("aria-selected", String(tabId === activeTab));
      }
      renderInspector();
    });
    tabButtons.set(id, button);
    tabList.append(button);
  }
  inspector.append(inspectorHeading, tabList, inspectorContent);
  workbench.append(eventPane, inspector);

  const selectedIds = new Set();
  const setSelection = (selected) => {
    selectedIds.clear();
    for (const id of selected) selectedIds.add(id);
    traceViewState.selectedIds = [...selectedIds];
    for (const [id, button] of eventButtons) {
      const isSelected = selectedIds.has(id);
      button.classList.toggle("is-selected", isSelected);
      button.setAttribute("aria-pressed", String(isSelected));
      bars.get(id)?.bar.classList.toggle("is-selected", isSelected);
    }
    selectionStatus.textContent = selectedIds.size > 0
      ? copy.traceSelectedCountTemplate.replace("{count}", String(selectedIds.size))
      : copy.traceSelectionHint;
    clearSelection.hidden = selectedIds.size === 0;
    renderInspector();
  };
  clearSelection.addEventListener("click", () => setSelection(new Set()));

  let dragStart;
  const localX = (event, plot) => event.clientX - plot.getBoundingClientRect().left;
  for (const plot of plots.values()) {
    plot.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) return;
      dragStart = localX(event, plot);
      selectionBox.hidden = false;
      selectionBox.style.left = `${labelWidth + dragStart}px`;
      selectionBox.style.width = "0px";
      plot.setPointerCapture(event.pointerId);
    });
    plot.addEventListener("pointermove", (event) => {
      if (dragStart === undefined) return;
      const point = localX(event, plot);
      selectionBox.style.left = `${labelWidth + Math.min(dragStart, point)}px`;
      selectionBox.style.width = `${Math.abs(point - dragStart)}px`;
    });
    plot.addEventListener("pointerup", (event) => {
      if (dragStart === undefined) return;
      const plotWidth = Number.parseFloat(plot.style.width);
      const endX = Math.max(0, Math.min(plotWidth, localX(event, plot)));
      const fromRatio = Math.min(dragStart, endX) / plotWidth;
      const toRatio = Math.max(dragStart, endX) / plotWidth;
      const selected = new Set();
      if (Math.abs(endX - dragStart) > 5) {
        for (const [id, position] of bars) {
          const entry = traces.find((trace) => trace.id === id);
          const entryEnd = position.startRatio + position.widthRatio;
          if (entry && entryEnd >= fromRatio && position.startRatio <= toRatio) selected.add(id);
        }
      }
      selectionBox.hidden = true;
      dragStart = undefined;
      setSelection(selected);
    });
    plot.addEventListener("pointercancel", () => {
      dragStart = undefined;
      selectionBox.hidden = true;
    });
  }

  overview.append(overviewHeader, overviewScroll);
  const availableIds = new Set(traces.map((entry) => entry.id));
  const savedIds = traceViewState.selectedIds;
  const initialSelection = savedIds === null
    ? new Set([traces[0].id])
    : new Set(savedIds.filter((id) => availableIds.has(id)));
  if (savedIds?.length && initialSelection.size === 0) initialSelection.add(traces[0].id);
  setSelection(initialSelection);
  return append(experience, overview, selectionToolbar, workbench);
}

async function renderJobDetails(version, jobId) {
  if (traceViewState?.jobId === jobId) {
    const eventList = app.querySelector(".trace-event-list");
    if (eventList) traceViewState.eventListScrollTop = eventList.scrollTop;
    traceViewState.expandedDetails = [...app.querySelectorAll(".trace-inspector-content details")]
      .flatMap((detail, index) => detail.open ? [index] : []);
  }
  const job = await api(`/api/ops/jobs/${encodeURIComponent(jobId)}`);
  if (version !== renderVersion) return;
  setUpdated(new Date().toISOString());
  const back = element("a", copy.backToJobs, "back-link");
  back.href = "#jobs";
  const details = element("dl", undefined, "detail-grid");
  detailItem(details, copy.statusFilter, copy.statuses[job.status] ?? job.status);
  detailItem(details, copy.typeFilter, copy.types[job.type] ?? job.type);
  detailItem(details, copy.projectMrDetails, `${job.projectId}:${job.mrIid}`);
  detailItem(details, copy.requesterId, job.actorId);
  detailItem(details, copy.created, formatDate(job.createdAt));
  detailItem(details, copy.lastUpdated, formatDate(job.updatedAt));
  detailItem(details, copy.headSha, job.headSha);
  detailItem(details, copy.attempts, job.attemptCount);
  detailItem(
    details,
    copy.failureStage,
    job.failureStage ? copy.statuses[job.failureStage] ?? job.failureStage : copy.none,
  );
  detailItem(details, copy.cancellationRequested, job.cancellationRequested ? copy.yes : copy.no);
  detailItem(details, copy.request, job.request || copy.none, "pre-wrap");
  if (job.lastError) detailNodeItem(details, copy.lastError, expandableText(job.lastError, copy.viewErrorDetails));
  else detailItem(details, copy.lastError, copy.none);
  const attempts = job.attempts.map((attempt) => {
    const row = element("tr");
    const error = element("td");
    error.append(attempt.error ? expandableText(attempt.error, copy.viewErrorDetails) : element("span", copy.none));
    append(
      row,
      element("td", attempt.attempt),
      element("td", formatDate(attempt.startedAt)),
      element("td", formatDate(attempt.finishedAt)),
      error,
    );
    return row;
  });
  const timelineRows = [
    { from: "created", to: "queued", at: job.createdAt },
    ...job.timeline,
  ].map((transition) => {
    const row = element("tr");
    const from = transition.from === "created"
      ? copy.createdState
      : copy.statuses[transition.from] ?? transition.from;
    const to = copy.statuses[transition.to] ?? transition.to;
    append(
      row,
      element(
        "td",
        copy.transitionTemplate.replace("{from}", from).replace("{to}", to),
      ),
      element("td", formatDate(transition.at)),
    );
    return row;
  });
  const timelineContent = table([copy.transition, copy.time], timelineRows);
  const attemptsContent = attempts.length
    ? table([copy.attempts, copy.started, copy.finished, copy.error], attempts)
    : element("div", copy.noAttempts, "empty");
  const trajectoryContent = createTraceExperience(job.trajectory, job.id);
  app.replaceChildren(
    back,
    heading(
      copy.jobDetailTitleTemplate.replace("{id}", job.id),
      copy.jobDetailDescription,
      statusBadge(job.status),
    ),
    panel(copy.taskDetails, details),
    panel(copy.lifecycleTimeline, timelineContent),
    panel(copy.traceDiagram, trajectoryContent),
    panel(copy.attemptHistory, attemptsContent),
  );
  const eventList = app.querySelector(".trace-event-list");
  if (eventList) eventList.scrollTop = traceViewState.eventListScrollTop;
  const inspectorDetails = app.querySelectorAll(".trace-inspector-content details");
  for (const index of traceViewState.expandedDetails) {
    if (inspectorDetails[index]) inspectorDetails[index].open = true;
  }
}

async function render() {
  const version = ++renderVersion;
  const route = location.hash.slice(1) || "overview";
  document.querySelectorAll("[data-nav]").forEach((link) => {
    link.classList.toggle("active", route === link.dataset.nav || route.startsWith("jobs/") && link.dataset.nav === "jobs");
  });
  try {
    if (route === "overview") await renderOverview(version);
    else if (route === "jobs") await renderJobs(version);
    else if (route.startsWith("jobs/")) {
      await renderJobDetails(version, decodeURIComponent(route.slice("jobs/".length)));
    } else {
      location.hash = "#overview";
    }
  } catch (error) {
    if (version === renderVersion) showError(error);
  }
}

function applyLocale() {
  document.documentElement.lang = locale;
  document.title = copy.documentTitle;
  document.querySelector(".brand").setAttribute("aria-label", copy.brandLabel);
  document.querySelector("nav").setAttribute("aria-label", copy.navLabel);
  document.querySelector('[data-nav="overview"]').textContent = copy.navOverview;
  document.querySelector('[data-nav="jobs"]').textContent = copy.navJobs;
  languageSelect.setAttribute("aria-label", copy.languageLabel);
  languageSelect.value = locale;
  const loading = document.querySelector("#loading");
  if (loading) loading.textContent = copy.loading;
  document.querySelector("footer").textContent = copy.footer;
}

languageSelect.addEventListener("change", () => {
  locale = resolveLocale(languageSelect.value, browserLanguages);
  copy = locale === "zh-CN" ? zhCN : en;
  try {
    window.localStorage.setItem(localePreferenceKey, locale);
  } catch (error) {
    window.console.warn("save operations UI language preference failed", error);
  }
  applyLocale();
  render();
});

applyLocale();
window.addEventListener("hashchange", render);
window.setInterval(render, 15_000);
render();
