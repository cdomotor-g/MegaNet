(function () {
  "use strict";

  const state = {
    tree: null,
    currentNodeId: null,
    history: [],
    currentMode: "node",
    currentPayload: null,
    currentResult: null,
    loadedFileName: "tree.json"
  };

  const STORAGE_KEY = "floodDecisionTool_unresolvedCases";
  const DEFAULT_ICON = "?";

  const els = {
    jsonFileInput: document.getElementById("jsonFileInput"),
    loadStatus: document.getElementById("loadStatus"),
    startupNotice: document.getElementById("startupNotice"),
    toolVersion: document.getElementById("toolVersion"),
    assessmentMetaCard: document.getElementById("assessmentMetaCard"),
    assessorInitialsInput: document.getElementById("assessorInitialsInput"),
    stationNumberInput: document.getElementById("stationNumberInput"),
    stationNameInput: document.getElementById("stationNameInput"),
    progressCard: document.getElementById("progressCard"),
    progressSummary: document.getElementById("progressSummary"),
    progressRemaining: document.getElementById("progressRemaining"),
    progressFill: document.getElementById("progressFill"),
    questionView: document.getElementById("questionView"),
    resultView: document.getElementById("resultView"),
    questionText: document.getElementById("questionText"),
    questionIcon: document.getElementById("questionIcon"),
    supportLinks: document.getElementById("supportLinks"),
    optionTargetGrid: document.getElementById("optionTargetGrid"),
    emptyTargets: document.getElementById("emptyTargets"),
    restartBtn: document.getElementById("restartBtn"),
    backBtn: document.getElementById("backBtn"),
    restartResultBtn: document.getElementById("restartResultBtn"),
    backResultBtn: document.getElementById("backResultBtn"),
    resultBox: document.getElementById("resultBox"),
    resultRecommendation: document.getElementById("resultRecommendation"),
    resultRationale: document.getElementById("resultRationale"),
    copyNodeIdBtn: document.getElementById("copyNodeIdBtn"),
    currentNodeCard: document.getElementById("currentNodeCard"),
    currentNodeIdPill: document.getElementById("currentNodeIdPill"),
    currentNodeJson: document.getElementById("currentNodeJson"),
    exportAssessmentBtn: document.getElementById("exportAssessmentBtn"),
    pathTableBody: document.getElementById("pathTableBody"),
    emptyTrail: document.getElementById("emptyTrail"),
    missingRuleBox: document.getElementById("missingRuleBox"),
    missingRuleText: document.getElementById("missingRuleText"),
    missingRuleSelect: document.getElementById("missingRuleSelect"),
    applyMissingRuleBtn: document.getElementById("applyMissingRuleBtn"),
    saveMissingRuleBtn: document.getElementById("saveMissingRuleBtn"),
    missingRuleSaveMessage: document.getElementById("missingRuleSaveMessage")
  };

  init();

  function init() {
    bindEvents();
    updateButtons();
    renderCurrentPayloadJson(null);
    renderOptionTargetRows(null);
    updateProgress();
  }

  function bindEvents() {
    els.jsonFileInput.addEventListener("change", handleJsonFileSelected);
    els.restartBtn.addEventListener("click", restart);
    els.backBtn.addEventListener("click", goBack);
    els.restartResultBtn.addEventListener("click", restart);
    els.backResultBtn.addEventListener("click", goBack);
    els.copyNodeIdBtn.addEventListener("click", copyCurrentId);
    els.exportAssessmentBtn.addEventListener("click", exportAssessmentReport);
    els.saveMissingRuleBtn.addEventListener("click", saveMissingRuleCase);
    els.applyMissingRuleBtn.addEventListener("click", applyMissingRuleSelection);
  }

  function handleJsonFileSelected(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const parsed = JSON.parse(e.target.result);
        validateTree(parsed);
        state.tree = parsed;
        state.loadedFileName = file.name || "tree.json";
        state.currentNodeId = parsed.startNode;
        state.history = [];
        state.currentMode = "node";
        state.currentPayload = parsed.nodes[parsed.startNode];
        state.currentResult = null;
        els.loadStatus.textContent = `Loaded: ${file.name}`;
        els.startupNotice.classList.add("hidden");
        els.assessmentMetaCard.classList.remove("hidden");
        els.progressCard.classList.remove("hidden");
        els.currentNodeCard.classList.remove("hidden");
        els.toolVersion.textContent = `Rule set: ${parsed.version || "-"}`;
        clearMissingRuleForm();
        hideResultView();
        renderNode();
      } catch (err) {
        els.loadStatus.textContent = `Error loading JSON: ${err.message}`;
        alert(`Could not load tree.json\n\n${err.message}`);
      }
    };
    reader.readAsText(file);
  }

  function validateTree(tree) {
    if (!tree || typeof tree !== "object") throw new Error("JSON root must be an object.");
    if (!tree.startNode) throw new Error("Missing 'startNode'.");
    if (!tree.nodes || typeof tree.nodes !== "object") throw new Error("Missing or invalid 'nodes'.");
    if (!tree.results || typeof tree.results !== "object") throw new Error("Missing or invalid 'results'.");
    if (!tree.nodes[tree.startNode]) throw new Error(`startNode '${tree.startNode}' does not exist in nodes.`);
    Object.values(tree.nodes).forEach((node) => {
      if (!node.id) throw new Error("Each node must have an 'id'.");
      if (!node.question) throw new Error(`Node '${node.id}' is missing 'question'.`);
      if (!Array.isArray(node.options)) throw new Error(`Node '${node.id}' is missing 'options' array.`);
      node.options.forEach((option, idx) => {
        if (!option.label) throw new Error(`Node '${node.id}' option ${idx + 1} is missing 'label'.`);
        if (!option.next) throw new Error(`Node '${node.id}' option '${option.label}' is missing 'next'.`);
      });
      if (node.links && !Array.isArray(node.links)) {
        throw new Error(`Node '${node.id}' has invalid 'links'. Use an array.`);
      }
    });
  }

  function restart() {
    if (!state.tree) return;
    state.currentNodeId = state.tree.startNode;
    state.history = [];
    state.currentMode = "node";
    state.currentPayload = state.tree.nodes[state.tree.startNode];
    state.currentResult = null;
    clearMissingRuleForm();
    hideResultView();
    renderNode();
  }

  function goBack() {
    if (!state.tree || state.history.length === 0) return;
    state.history.pop();
    if (state.history.length === 0) {
      state.currentNodeId = state.tree.startNode;
    } else {
      const previous = state.history[state.history.length - 1];
      state.currentNodeId = state.tree.nodes[previous.next] ? previous.next : previous.nodeId;
    }
    state.currentMode = "node";
    state.currentPayload = state.tree.nodes[state.currentNodeId];
    state.currentResult = null;
    clearMissingRuleForm();
    hideResultView();
    renderNode();
  }

  function renderNode() {
    if (!state.tree) return;
    const node = state.tree.nodes[state.currentNodeId];
    if (!node) {
      renderResult({
        id: "RESULT_NO_RULE",
        title: "No current recommendation",
        rationale: `Node '${state.currentNodeId}' does not exist in the current tree.`,
        isMissingRule: true
      });
      return;
    }
    state.currentMode = "node";
    state.currentPayload = node;
    state.currentResult = null;
    els.questionView.classList.remove("hidden");
    els.resultView.classList.add("hidden");
    els.questionText.textContent = node.question;
    els.questionIcon.textContent = getIcon(node);
    renderSupportLinks(node);
    renderOptionTargetRows(node);
    renderCurrentNode(node);
    renderCurrentPayloadJson(node);
    renderPathTable();
    updateProgress();
    updateButtons();
  }

  function selectOption(node, option) {
    state.history.push({
      nodeId: node.id,
      question: node.question,
      answer: option.label,
      next: option.next,
      icon: getIcon(node)
    });
    const nextId = option.next;
    if (state.tree.nodes[nextId]) {
      state.currentNodeId = nextId;
      renderNode();
      return;
    }
    if (state.tree.results[nextId]) {
      renderResult(state.tree.results[nextId]);
      return;
    }
    renderResult({
      id: "RESULT_NO_RULE",
      title: "No current recommendation",
      rationale: `The selected option points to '${nextId}', which does not exist in nodes or results.`,
      isMissingRule: true
    });
  }

  function renderResult(result) {
    state.currentMode = "result";
    state.currentPayload = result;
    state.currentResult = result;
    els.questionView.classList.add("hidden");
    els.resultView.classList.remove("hidden");
    els.resultRecommendation.textContent = result.title || "Recommendation unavailable";
    els.resultRationale.textContent = result.rationale || "";

    if (result.isMissingRule) {
      els.resultBox.classList.add("warning");
      els.missingRuleBox.classList.remove("hidden");
      populateMissingRuleOptions();
    } else {
      els.resultBox.classList.remove("warning");
      els.missingRuleBox.classList.add("hidden");
      clearMissingRuleForm();
    }

    renderCurrentNode(result);
    renderCurrentPayloadJson(result);
    renderOptionTargetRows(null);
    renderPathTable(result);
    updateProgress();
    updateButtons();
  }

  function getIcon(node) {
    if (!node) return DEFAULT_ICON;
    return String(node.icon || DEFAULT_ICON).trim() || DEFAULT_ICON;
  }

  function renderSupportLinks(node) {
    els.supportLinks.innerHTML = "";
    const links = node && Array.isArray(node.links) ? node.links.filter((l) => l && l.url) : [];
    if (!links.length) {
      els.supportLinks.classList.add("hidden");
      return;
    }
    links.forEach((link) => {
      const a = document.createElement("a");
      a.className = "support-link";
      a.href = link.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = `${link.label || 'Supporting document'} ↗`;
      els.supportLinks.appendChild(a);
    });
    els.supportLinks.classList.remove("hidden");
  }

  function populateMissingRuleOptions() {
    els.missingRuleSelect.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a result...";
    els.missingRuleSelect.appendChild(placeholder);

    Object.values(state.tree.results)
      .filter((result) => !result.isMissingRule)
      .sort((a, b) => String(a.title || a.id).localeCompare(String(b.title || b.id)))
      .forEach((result) => {
        const option = document.createElement("option");
        option.value = result.id;
        option.textContent = `${result.title} — ${result.id}`;
        els.missingRuleSelect.appendChild(option);
      });

    els.missingRuleSelect.value = "";
  }

  function renderCurrentNode(payload) {
    els.currentNodeIdPill.textContent = payload && payload.id ? payload.id : "-";
  }

  function hideResultView() {
    els.questionView.classList.remove("hidden");
    els.resultView.classList.add("hidden");
  }

  function renderCurrentPayloadJson(payload) {
    els.currentNodeJson.textContent = payload ? JSON.stringify(payload, null, 2) : "No tree loaded yet.";
  }

  function renderOptionTargetRows(node) {
    els.optionTargetGrid.innerHTML = "";
    if (!node || !Array.isArray(node.options) || node.options.length === 0) {
      els.emptyTargets.classList.remove("hidden");
      return;
    }
    els.emptyTargets.classList.add("hidden");

    node.options.forEach((option) => {
      const row = document.createElement("div");
      row.className = "option-target-row";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "option-btn";
      button.textContent = option.label;
      button.addEventListener("click", () => selectOption(node, option));

      const target = document.createElement("div");
      target.className = "target-cell";
      const id = document.createElement("div");
      id.className = "target-id";
      id.textContent = option.next;
      const meta = document.createElement("div");
      meta.className = "target-meta";
      if (state.tree && state.tree.nodes[option.next]) meta.textContent = "Question node";
      else if (state.tree && state.tree.results[option.next]) meta.textContent = "Result";
      else meta.textContent = "Unknown";

      target.appendChild(id);
      target.appendChild(meta);
      row.appendChild(button);
      row.appendChild(target);
      els.optionTargetGrid.appendChild(row);
    });
  }

  function renderPathTable(result) {
    els.pathTableBody.innerHTML = "";
    if (state.history.length === 0 && !result) {
      els.emptyTrail.classList.remove("hidden");
      return;
    }
    els.emptyTrail.classList.add("hidden");

    state.history.forEach((step, index) => {
      const tr = document.createElement("tr");
      const tdIndex = document.createElement("td");
      tdIndex.className = "index-col";
      tdIndex.textContent = index + 1;

      const tdQuestion = document.createElement("td");
      const wrap = document.createElement("div");
      wrap.className = "path-question-cell";
      const icon = document.createElement("span");
      icon.className = "path-icon";
      icon.textContent = step.icon || DEFAULT_ICON;
      const text = document.createElement("div");
      text.textContent = step.question;
      wrap.appendChild(icon);
      wrap.appendChild(text);
      tdQuestion.appendChild(wrap);

      const tdAnswer = document.createElement("td");
      tdAnswer.textContent = step.answer;
      tr.appendChild(tdIndex);
      tr.appendChild(tdQuestion);
      tr.appendChild(tdAnswer);
      els.pathTableBody.appendChild(tr);
    });

    if (result) {
      const tr = document.createElement("tr");
      const tdIndex = document.createElement("td");
      tdIndex.className = "index-col";
      tdIndex.textContent = state.history.length + 1;
      const tdQuestion = document.createElement("td");
      tdQuestion.textContent = "Outcome";
      const tdAnswer = document.createElement("td");
      tdAnswer.textContent = result.title || "Recommendation unavailable";
      tr.appendChild(tdIndex);
      tr.appendChild(tdQuestion);
      tr.appendChild(tdAnswer);
      els.pathTableBody.appendChild(tr);
    }
  }

  function estimateRemainingSteps(currentNodeId, visiting = new Set()) {
    if (!state.tree || !currentNodeId) return 0;
    if (state.tree.results[currentNodeId]) return 0;
    const node = state.tree.nodes[currentNodeId];
    if (!node || visiting.has(currentNodeId)) return 0;
    visiting.add(currentNodeId);
    const distances = node.options.map((option) => {
      if (state.tree.results[option.next]) return 1;
      if (state.tree.nodes[option.next]) return 1 + estimateRemainingSteps(option.next, new Set(visiting));
      return 1;
    });
    return distances.length ? Math.min(...distances) : 0;
  }

  function updateProgress() {
    const completedSteps = state.history.length;
    const remainingSteps = state.currentMode === "result"
      ? 0
      : estimateRemainingSteps(state.currentNodeId);
    const totalEstimate = Math.max(completedSteps + remainingSteps, 1);
    const pct = state.currentMode === "result" ? 100 : Math.round((completedSteps / totalEstimate) * 100);

    els.progressSummary.textContent = `Answered ${completedSteps} step${completedSteps === 1 ? '' : 's'}`;
    els.progressRemaining.textContent = state.currentMode === "result"
      ? "Complete"
      : `Approx. ${remainingSteps} step${remainingSteps === 1 ? '' : 's'} remaining`;
    els.progressFill.style.width = `${pct}%`;
  }

  function updateButtons() {
    const hasTree = !!state.tree;
    const canGoBack = hasTree && state.history.length > 0;
    const canExport = hasTree && (state.history.length > 0 || !!state.currentResult);
    els.restartBtn.disabled = !hasTree;
    els.backBtn.disabled = !canGoBack;
    els.restartResultBtn.disabled = !hasTree;
    els.backResultBtn.disabled = !canGoBack;
    els.copyNodeIdBtn.disabled = !hasTree;
    els.exportAssessmentBtn.disabled = !canExport;
    els.applyMissingRuleBtn.disabled = !hasTree || !state.currentResult || !state.currentResult.isMissingRule;
    els.saveMissingRuleBtn.disabled = !hasTree || !state.currentResult || !state.currentResult.isMissingRule;

    [els.restartBtn, els.restartResultBtn, els.copyNodeIdBtn].forEach((btn) => styleButtonEnabled(btn, !btn.disabled));
    [els.backBtn, els.backResultBtn, els.exportAssessmentBtn, els.applyMissingRuleBtn, els.saveMissingRuleBtn].forEach((btn) => styleButtonEnabled(btn, !btn.disabled));
  }

  function styleButtonEnabled(btn, enabled) {
    btn.style.opacity = enabled ? "1" : "0.55";
    btn.style.cursor = enabled ? "pointer" : "not-allowed";
  }

  function applyMissingRuleSelection() {
    if (!state.tree) return;
    const selectedResultId = els.missingRuleSelect.value;
    if (!selectedResultId || !state.tree.results[selectedResultId]) {
      els.missingRuleSaveMessage.textContent = "Select a result first.";
      return;
    }

    const lastStep = state.history[state.history.length - 1];
    if (!lastStep) {
      els.missingRuleSaveMessage.textContent = "No decision path available to update.";
      return;
    }

    const sourceNode = state.tree.nodes[lastStep.nodeId];
    const sourceOption = sourceNode && Array.isArray(sourceNode.options)
      ? sourceNode.options.find((option) => option.label === lastStep.answer)
      : null;

    if (!sourceNode || !sourceOption) {
      els.missingRuleSaveMessage.textContent = "Could not find the source branch to update.";
      return;
    }

    const previousTarget = sourceOption.next;
    sourceOption.next = selectedResultId;

    const note = els.missingRuleText.value.trim();
    if (!Array.isArray(state.tree.changeLog)) state.tree.changeLog = [];
    state.tree.changeLog.push({
      changedAt: new Date().toISOString(),
      type: "missingRuleMappedToExistingResult",
      sourceNodeId: sourceNode.id,
      optionLabel: sourceOption.label,
      previousTarget,
      newTarget: selectedResultId,
      note: note || null
    });

    downloadJson(JSON.stringify(state.tree, null, 2), buildUpdatedFileName());
    els.missingRuleSaveMessage.textContent = `Updated ${sourceNode.id} / ${sourceOption.label} -> ${selectedResultId}. Download started.`;
    renderResult(state.tree.results[selectedResultId]);
  }

  function buildUpdatedFileName() {
    const original = state.loadedFileName || "tree.json";
    return original.toLowerCase().endsWith(".json") ? original.replace(/\.json$/i, "_updated.json") : `${original}_updated.json`;
  }

  function saveMissingRuleCase() {
    const proposedRecommendation = els.missingRuleText.value.trim();
    if (!proposedRecommendation) {
      els.missingRuleSaveMessage.textContent = "Enter notes first, or pick a result and apply it.";
      return;
    }
    const payload = {
      savedAt: new Date().toISOString(),
      treeTitle: state.tree ? state.tree.title || "" : "",
      treeVersion: state.tree ? state.tree.version || "" : "",
      path: state.history.map((step, index) => ({
        step: index + 1,
        nodeId: step.nodeId,
        question: step.question,
        answer: step.answer,
        next: step.next,
        icon: step.icon
      })),
      selectedResultId: els.missingRuleSelect.value || null,
      proposedRecommendation
    };
    const existing = readUnresolvedCases();
    existing.push(payload);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing, null, 2));
    els.missingRuleSaveMessage.textContent = "Unresolved case saved in this browser.";
  }

  function readUnresolvedCases() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_err) {
      return [];
    }
  }

  function clearMissingRuleForm() {
    els.missingRuleSelect.innerHTML = "";
    els.missingRuleText.value = "";
    els.missingRuleSaveMessage.textContent = "";
  }

  async function copyCurrentId() {
    const text = els.currentNodeIdPill.textContent || "";
    if (!text || text === "-") return;
    try {
      await navigator.clipboard.writeText(text);
      flashButtonText(els.copyNodeIdBtn, "Copied");
    } catch (_err) {
      alert(`Could not copy automatically.\n\nCurrent ID: ${text}`);
    }
  }

  function validateReportInputs() {
    const missing = [];
    if (!els.assessorInitialsInput.value.trim()) missing.push({ label: "assessor initials", el: els.assessorInitialsInput });
    if (!els.stationNumberInput.value.trim()) missing.push({ label: "station number", el: els.stationNumberInput });
    if (!els.stationNameInput.value.trim()) missing.push({ label: "station name", el: els.stationNameInput });
    return missing;
  }

  function exportAssessmentReport() {
    if (!state.tree || (state.history.length === 0 && !state.currentResult)) return;
    const missing = validateReportInputs();
    if (missing.length) {
      alert(`Please go back and enter: ${missing.map((item) => item.label).join(", ")}.`);
      if (missing[0] && missing[0].el) missing[0].el.focus();
      return;
    }

    const now = new Date();
    const reportTitle = `${state.tree.title || 'Assessment'} – ${els.stationNameInput.value.trim()}`;
    const reportHtml = buildReportHtml({
      title: reportTitle,
      generatedAt: now,
      assessorInitials: els.assessorInitialsInput.value.trim(),
      stationNumber: els.stationNumberInput.value.trim(),
      stationName: els.stationNameInput.value.trim()
    });

    const fileStem = slugify(`${els.stationNumberInput.value.trim() || 'station'}_${els.stationNameInput.value.trim() || 'assessment'}`);
    downloadHtml(reportHtml, `${fileStem}_assessment_report.html`);
  }

  function buildReportHtml(meta) {
    const dateText = meta.generatedAt.toLocaleString();
    const rows = state.history.map((step, index) => `
      <tr>
        <td>${index + 1}</td>
        <td><span class="icon">${escapeHtml(step.icon || DEFAULT_ICON)}</span> ${escapeHtml(step.question)}</td>
        <td>${escapeHtml(step.answer)}</td>
      </tr>
    `).join("");

    const outcomeRow = state.currentResult ? `
      <tr>
        <td>${state.history.length + 1}</td>
        <td>Outcome</td>
        <td>${escapeHtml(state.currentResult.title || 'Recommendation unavailable')}</td>
      </tr>
    ` : "";

    const rationaleBlock = state.currentResult ? `
      <section class="box">
        <h2>Recommendation</h2>
        <p><strong>${escapeHtml(state.currentResult.title || 'Recommendation unavailable')}</strong></p>
        <p>${escapeHtml(state.currentResult.rationale || '')}</p>
      </section>
    ` : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(meta.title)}</title>
  <style>
    body { font-family: Segoe UI, Arial, sans-serif; margin: 32px; color: #111827; }
    h1 { margin-bottom: 8px; }
    h2 { margin: 0 0 8px 0; font-size: 18px; }
    .meta { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 12px; margin-bottom: 24px; }
    .box { border: 1px solid #d1d5db; border-radius: 10px; padding: 14px; margin-bottom: 18px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #d1d5db; text-align: left; padding: 10px; vertical-align: top; }
    th { background: #f3f4f6; }
    .icon { display:inline-flex; align-items:center; justify-content:center; width: 22px; height: 22px; border-radius: 999px; border:1px solid #cbd5e1; margin-right:6px; font-weight:700; }
    .foot { margin-top: 24px; color:#4b5563; font-size: 12px; }
    @media print { body { margin: 14mm; } }
  </style>
</head>
<body>
  <h1>${escapeHtml(state.tree.title || 'FWIN-TIDE Assessment')}</h1>
  <p>Generated ${escapeHtml(dateText)}</p>

  <section class="box">
    <h2>Assessment details</h2>
    <div class="meta">
      <div><strong>Assessor initials:</strong> ${escapeHtml(meta.assessorInitials)}</div>
      <div><strong>Station number:</strong> ${escapeHtml(meta.stationNumber || '-')}</div>
      <div><strong>Station name:</strong> ${escapeHtml(meta.stationName)}</div>
      <div><strong>Rule set:</strong> ${escapeHtml(state.tree.version || '-')}</div>
    </div>
  </section>

  <section class="box">
    <h2>Decision path</h2>
    <table>
      <thead><tr><th>#</th><th>Question</th><th>Answer</th></tr></thead>
      <tbody>${rows}${outcomeRow}</tbody>
    </table>
  </section>

  ${rationaleBlock}

  <p class="foot">Open this report in a browser and print to PDF.</p>
</body>
</html>`;
  }

  function downloadHtml(content, fileName) {
    downloadFile(content, fileName, "text/html");
  }

  function downloadJson(content, fileName) {
    downloadFile(content, fileName, "application/json");
  }

  function downloadFile(content, fileName, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 200);
  }

  function slugify(value) {
    return String(value || "assessment")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "assessment";
  }

  function flashButtonText(button, temporaryText) {
    const original = button.textContent;
    button.textContent = temporaryText;
    setTimeout(() => { button.textContent = original; }, 1000);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
})();
