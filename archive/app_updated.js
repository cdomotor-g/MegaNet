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

  const els = {
    jsonFileInput: document.getElementById("jsonFileInput"),
    loadStatus: document.getElementById("loadStatus"),
    startupNotice: document.getElementById("startupNotice"),
    toolVersion: document.getElementById("toolVersion"),
    questionView: document.getElementById("questionView"),
    resultView: document.getElementById("resultView"),
    questionText: document.getElementById("questionText"),
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
    currentNodeIdPill: document.getElementById("currentNodeIdPill"),
    currentNodeJson: document.getElementById("currentNodeJson"),
    copyPathBtn: document.getElementById("copyPathBtn"),
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
  }

  function bindEvents() {
    els.jsonFileInput.addEventListener("change", handleJsonFileSelected);
    els.restartBtn.addEventListener("click", restart);
    els.backBtn.addEventListener("click", goBack);
    els.restartResultBtn.addEventListener("click", restart);
    els.backResultBtn.addEventListener("click", goBack);
    els.copyNodeIdBtn.addEventListener("click", copyCurrentId);
    els.copyPathBtn.addEventListener("click", copyDecisionPath);
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
      const nextId = previous.next;
      state.currentNodeId = state.tree.nodes[nextId] ? nextId : previous.nodeId;
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
    renderOptionTargetRows(node);
    renderCurrentNode(node);
    renderCurrentPayloadJson(node);
    renderPathTable();
    updateButtons();
  }

  function selectOption(node, option) {
    state.history.push({
      nodeId: node.id,
      question: node.question,
      answer: option.label,
      next: option.next
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
    updateButtons();
  }

  function populateMissingRuleOptions() {
    if (!state.tree || !els.missingRuleSelect) return;
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
      if (state.tree && state.tree.nodes[option.next]) {
        meta.textContent = "Question node";
      } else if (state.tree && state.tree.results[option.next]) {
        meta.textContent = "Result";
      } else {
        meta.textContent = "Unknown";
      }

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
      tdQuestion.textContent = step.question;
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

  function buildDecisionPathText() {
    const lines = ["Step\tQuestion\tAnswer"];
    state.history.forEach((step, index) => {
      lines.push(`${index + 1}\t${step.question}\t${step.answer}`);
    });
    if (state.currentResult) {
      lines.push(`${state.history.length + 1}\tOutcome\t${state.currentResult.title || "Recommendation unavailable"}`);
    }
    return lines.join("\n");
  }

  async function copyDecisionPath() {
    const text = buildDecisionPathText();
    if (!text || text.trim() === "Step\tQuestion\tAnswer") return;
    try {
      await navigator.clipboard.writeText(text);
      flashButtonText(els.copyPathBtn, "Copied");
    } catch (_err) {
      alert("Could not copy automatically.");
    }
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

  function updateButtons() {
    const hasTree = !!state.tree;
    const canGoBack = hasTree && state.history.length > 0;
    const hasPath = state.history.length > 0 || !!state.currentResult;

    els.restartBtn.disabled = !hasTree;
    els.backBtn.disabled = !canGoBack;
    els.restartResultBtn.disabled = !hasTree;
    els.backResultBtn.disabled = !canGoBack;
    els.copyNodeIdBtn.disabled = !hasTree;
    els.copyPathBtn.disabled = !hasPath;
    els.applyMissingRuleBtn.disabled = !hasTree || !state.currentResult || !state.currentResult.isMissingRule;
    els.saveMissingRuleBtn.disabled = !hasTree || !state.currentResult || !state.currentResult.isMissingRule;

    [els.restartBtn, els.restartResultBtn, els.copyNodeIdBtn].forEach((btn) => {
      btn.style.opacity = hasTree ? "1" : "0.55";
      btn.style.cursor = hasTree ? "pointer" : "not-allowed";
    });
    [els.backBtn, els.backResultBtn].forEach((btn) => {
      btn.style.opacity = canGoBack ? "1" : "0.55";
      btn.style.cursor = canGoBack ? "pointer" : "not-allowed";
    });
    [els.copyPathBtn, els.applyMissingRuleBtn, els.saveMissingRuleBtn].forEach((btn) => {
      const enabled = !btn.disabled;
      btn.style.opacity = enabled ? "1" : "0.55";
      btn.style.cursor = enabled ? "pointer" : "not-allowed";
    });
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
    if (note) {
      if (!Array.isArray(state.tree.changeLog)) state.tree.changeLog = [];
      state.tree.changeLog.push({
        changedAt: new Date().toISOString(),
        type: "missingRuleMappedToExistingResult",
        sourceNodeId: sourceNode.id,
        optionLabel: sourceOption.label,
        previousTarget,
        newTarget: selectedResultId,
        note
      });
    }

    downloadUpdatedTreeJson();
    els.missingRuleSaveMessage.textContent = `Updated ${sourceNode.id} / ${sourceOption.label} -> ${selectedResultId}. Download started.`;
    renderResult(state.tree.results[selectedResultId]);
  }

  function downloadUpdatedTreeJson() {
    const fileName = buildUpdatedFileName();
    const blob = new Blob([JSON.stringify(state.tree, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 200);
  }

  function buildUpdatedFileName() {
    const original = state.loadedFileName || "tree.json";
    if (!original.toLowerCase().endsWith(".json")) return `${original}_updated.json`;
    return original.replace(/\.json$/i, "_updated.json");
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
        next: step.next
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
    if (els.missingRuleSelect) els.missingRuleSelect.innerHTML = "";
    if (els.missingRuleText) els.missingRuleText.value = "";
    if (els.missingRuleSaveMessage) els.missingRuleSaveMessage.textContent = "";
  }

  function flashButtonText(button, temporaryText) {
    const original = button.textContent;
    button.textContent = temporaryText;
    setTimeout(() => {
      button.textContent = original;
    }, 1000);
  }
})();
