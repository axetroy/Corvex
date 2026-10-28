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

async function renderJobDetails(version, jobId) {
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
  detailItem(details, copy.lastError, job.lastError || copy.none, "pre-wrap");
  const attempts = job.attempts.map((attempt) => {
    const row = element("tr");
    append(
      row,
      element("td", attempt.attempt),
      element("td", formatDate(attempt.startedAt)),
      element("td", formatDate(attempt.finishedAt)),
      element("td", attempt.error || copy.none, "pre-wrap"),
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
  const traceRows = job.trajectory.map((entry) => {
    const row = element("tr");
    append(
      row,
      element("td", entry.attempt),
      element("td", copy.traceKinds[entry.kind] ?? entry.kind),
      element("td", entry.name),
      element("td", copy.traceStatuses[entry.status] ?? entry.status),
      element("td", formatDate(entry.startedAt)),
      element("td", formatTraceDuration(entry.durationMs)),
      element("td", entry.model || copy.none),
      element("td", entry.inputTokens ?? copy.none),
      element("td", entry.outputTokens ?? copy.none),
    );
    return row;
  });
  const trajectoryContent = traceRows.length
    ? table(
        [
          copy.traceAttempt,
          copy.task,
          copy.traceName,
          copy.traceStatus,
          copy.started,
          copy.duration,
          copy.traceModel,
          copy.inputTokens,
          copy.outputTokens,
        ],
        traceRows,
      )
    : element("div", copy.noTrajectory, "empty");
  app.replaceChildren(
    back,
    heading(
      copy.jobDetailTitleTemplate.replace("{id}", job.id),
      copy.jobDetailDescription,
      statusBadge(job.status),
    ),
    panel(copy.taskDetails, details),
    panel(copy.lifecycleTimeline, timelineContent),
    panel(copy.trajectory, trajectoryContent),
    panel(copy.attemptHistory, attemptsContent),
  );
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
