import { COUNTRY_OPTIONS, buildShippingIndex, formatMoney, inferSellerCountry, parseCart, parseMoney } from "./parser.mjs?v=20260509m";
import {
  calculateShippingCost,
  calculateTrusteeFee,
  estimateShipmentWeight,
  SHIPPING_DATA_INCLUDES_CARDMARKET_FEE
} from "./shipping.mjs?v=20260509m";
import {
  getReferencePrice,
  enrichCardsWithReferencePrices,
  initScryallCache
} from "./scryfall.mjs?v=20260509m";
import {
  calculatePriceDelta,
  getDeltaColor,
  formatDeltaDisplay,
  enrichCardWithReference,
  hasHighPricedCards,
  generateHighPriceNote
} from "./price-verdict.mjs?v=20260509m";
import { decodeCartForgeHash, decodeCartForgePayload, parseExtractedCartPayload } from "./importer.mjs?v=20260509m";
import { buildConfirmedPlan } from "./confirmed-plan.mjs?v=20260511a";
import { sendConfirmedPlanToExtension } from "./extension-bridge.mjs?v=20260511a";
import { escapeHtml, escapeAttribute } from "./utils.mjs";
import { applyShippingOverride } from "./shipping-override.mjs";

const manaClasses = ["mana-w", "mana-u", "mana-b", "mana-r", "mana-g"];
const MAX_OPTIMIZATION_ITERATIONS = 50;

const ICON_CHART = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"></path><path d="M18 17V9"></path><path d="M13 17V5"></path><path d="M8 17v-4"></path></svg>`;
const ICON_CART = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"></path></svg>`;
const ICON_LIST = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M7 8h10M7 12h10M7 16h6"></path></svg>`;
const ICON_INFO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg>`;

const state = {
  shippingData: null,
  shippingDataState: "loading", // "loading" | "loaded" | "error"
  parsed: parseCart(""),
  optimizationResult: null,
  inputCollapsed: false,
  desiredQuantityByCard: {},
  optimizationStale: false,
  expandedCards: new Set(),
  variantPreferences: {},
  // Reference price check feature
  priceReferences: {}, // Map<normalizedCardName, referencePriceData>
  scryallLookupInProgress: false, // Show loading state while fetching
  referenceCheckEnabled: true, // Can be disabled in settings (v2)
  activeReferenceLookupToken: 0,
  inputSource: "manual", // "manual" | "extension"
  showManualFallback: false,
  extensionHintFromUrl: false,
  lastImportedFingerprint: "",
  reviewUnlocked: false,
  cardmarketCartUrl: null
};

const hasDom = typeof document !== "undefined";

const elements = hasDom ? {
  cartInput: document.querySelector("#cartInput"),
  parseButton: document.querySelector("#parseButton"),
  loadSampleButton: document.querySelector("#loadSampleButton"),
  clearButton: document.querySelector("#clearButton"),
  editCartButton: document.querySelector("#editCartButton"),
  runOptimizationButton: document.querySelector("#runOptimizationButton"),
  desiredCardsReview: document.querySelector("#desiredCardsReview"),
  desiredCardsSection: document.querySelector("#desiredCardsSection"),
  summaryStrip: document.querySelector("#summaryStrip"),
  summarySection: document.querySelector("#summarySection"),
  optimizationSummary: document.querySelector("#optimizationSummary"),
  parseMessage: document.querySelector("#parseMessage"),
  inputEyebrow: document.querySelector("#inputEyebrow"),
  inputHeading: document.querySelector("#inputHeading"),
  inputDescription: document.querySelector("#inputDescription"),
  workflowHint: document.querySelector("#workflowHint"),
  inputEditor: document.querySelector("#inputEditor"),
  extensionImportCard: document.querySelector("#extensionImportCard"),
  cartInputFieldWrap: document.querySelector("#cartInputFieldWrap"),
  extensionManualFallbackToggle: document.querySelector("#extensionManualFallbackToggle"),
  inputSummary: document.querySelector("#inputSummary"),
  optimizationState: document.querySelector("#optimizationState"),
  optimizationNotes: document.querySelector("#optimizationNotes"),
  optimizationOutput: document.querySelector("#optimizationOutput"),
  recommendationSection: document.querySelector("#recommendationSection"),
  advancedDetails: document.querySelector("#advancedDetails"),
  notesPanel: document.querySelector("#notesPanel"),
  emptyStateTemplate: document.querySelector("#emptyStateTemplate")
} : {};

if (hasDom) {
  boot();
}

async function boot() {
  window.__cartforgeParse = parseCurrentInput;
  window.__cartforgeBuildConfirmedPlan = buildCurrentConfirmedPlan;
  window.__cartforgeSendConfirmedPlan = sendCurrentConfirmedPlanToExtension;

  // Initialize Scryfall cache for reference price lookups
  if (state.referenceCheckEnabled) {
    initScryallCache().catch(error => {
      console.error('Failed to initialize Scryfall cache:', error);
    });
  }

  elements.parseButton.addEventListener("click", () => parseCurrentInput({ autoReveal: true }));
  if (elements.loadSampleButton) {
    elements.loadSampleButton.addEventListener("click", loadSampleCart);
  }
  elements.clearButton.addEventListener("click", clearInput);
  elements.desiredCardsReview.addEventListener("change", handleDesiredQuantityChange);
  elements.desiredCardsReview.addEventListener("click", handleDesiredQuantityClick);
  elements.desiredCardsReview.addEventListener("change", handleReviewChange);
  elements.desiredCardsReview.addEventListener("click", handleReviewClick);

  await loadShippingData();
  loadCartFromUrlHash();
  render();
}

async function buildCurrentConfirmedPlan() {
  if (!state.optimizationResult) {
    return {
      ok: false,
      error: "Build an optimized buying plan before creating a confirmed plan."
    };
  }

  return {
    ok: true,
    plan: await buildConfirmedPlan(state.parsed, state.optimizationResult)
  };
}

async function sendCurrentConfirmedPlanToExtension() {
  const result = await buildCurrentConfirmedPlan();
  if (!result.ok) {
    return result;
  }
  return sendConfirmedPlanToExtension(result.plan);
}

async function handleConfirmPlan() {
  const btn = document.querySelector("#confirmPlanButton");
  const status = document.querySelector("#confirmPlanStatus");
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = "Confirming…";
  if (status) status.textContent = "";

  const result = await sendCurrentConfirmedPlanToExtension();

  if (result.ok) {
    btn.textContent = "Plan confirmed ✓";
    if (state.cardmarketCartUrl) {
      window.open(state.cardmarketCartUrl, "_blank", "noopener,noreferrer");
      if (status) status.textContent = "Opening your Cardmarket cart…";
    } else {
      if (status) status.textContent = "Saved to extension. Open your Cardmarket cart.";
    }
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = "Send to Cardmarket";
      if (status) status.textContent = "";
    }, 4000);
  } else {
    btn.disabled = false;
    btn.textContent = "Send to Cardmarket";
    if (status) status.textContent = result.error || "Extension not available.";
    setTimeout(() => {
      if (status) status.textContent = "";
    }, 4000);
  }
}

function loadCartFromUrlHash() {
  const sourceParam = new URLSearchParams(window.location.search).get("source");
  state.extensionHintFromUrl = sourceParam === "cardmarket-extension";
  const decoded = decodeCartForgeHash(window.location.hash);
  if (!decoded.ok) {
    if (state.extensionHintFromUrl) {
      state.inputSource = "extension";
      setMessage("Extension opened Kaikata, but no cart payload was found. Try importing again.");
      updateWorkflowStatus("Waiting for cart", "warning", "Use the extension import again, or paste your cart manually.");
      render();
    }
    return;
  }

  elements.cartInput.value = JSON.stringify(decoded.payload, null, 2);
  if (decoded.payload?.url && typeof decoded.payload.url === "string") {
    state.cardmarketCartUrl = decoded.payload.url;
  }
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  parseCurrentInput({ autoReveal: true });
}

async function loadShippingData() {
  state.shippingDataState = "loading";
  updateOptimizeButton();
  try {
    const response = await fetch("./shipping_data.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    state.shippingData = await response.json();
    state.shippingDataState = "loaded";
    updateOptimizeButton();
    render();
  } catch (error) {
    state.shippingData = null;
    state.shippingDataState = "error";
    updateOptimizeButton();
    render();
  }
}

function updateOptimizeButton() {
  const { shippingDataState } = state;
  elements.parseButton.disabled = false;
  elements.parseButton.textContent = "Review cart";

  if (shippingDataState === "error" && !state.parsed.sellers?.length && !state.optimizationResult) {
    updateWorkflowStatus("Ready to parse", "warning", "Shipping data is unavailable here. Review still works.");
  }
}

async function loadSampleCart() {
  try {
    const response = await fetch("./sample-cart-mobile.txt", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    elements.cartInput.value = await response.text();
    parseCurrentInput();
  } catch (error) {
    setMessage("Could not load sample-cart-mobile.txt from this static directory.");
  }
}

function parseCurrentInput(options = {}) {
  const { autoReveal = true } = options;
  if (elements.parseButton) {
    elements.parseButton.textContent = "Parsing…";
  }

  state.activeReferenceLookupToken += 1;
  state.priceReferences = {};
  state.scryallLookupInProgress = false;
  state.expandedCards = new Set();
  state.variantPreferences = {};
  const imported = parseExtractedCartPayload(elements.cartInput.value, state.shippingData);
  const extensionDecoded = decodeCartForgePayload(elements.cartInput.value);
  state.inputSource = imported.ok || extensionDecoded.ok ? "extension" : "manual";

  if (imported.ok) {
    const fingerprint = JSON.stringify(imported.parsed.rawText || "");
    if (fingerprint && fingerprint === state.lastImportedFingerprint && state.parsed.sellerCount) {
      setMessage("Same extension payload received again. Existing review data was refreshed.");
    }
    state.lastImportedFingerprint = fingerprint;
  }

  state.parsed = imported.ok ? imported.parsed : parseCart(elements.cartInput.value, state.shippingData);
  inferSellerCountryFromShippingMethod(state.parsed.sellers);
  state.reviewUnlocked = autoReveal;
  state.optimizationResult = null;
  state.optimizationStale = true;
  const warningText = state.parsed.warnings.length ? ` ${state.parsed.warnings.join(" ")}` : "";
  const offerGroups = buildOfferGroups(state.parsed.sellers);

  state.desiredQuantityByCard = {};
  offerGroups.forEach((group) => {
    state.desiredQuantityByCard[group.cardName] = group.requiredQuantity;
  });

  const totalCopies = getTotalCopies(offerGroups);
  if (!state.parsed.sellerCount || !offerGroups.length) {
    if (!imported.ok && /CARTFORGE_CART=|^\s*\{/.test(String(elements.cartInput.value || "").trim())) {
      setMessage("Cart payload could not be read. Please re-import from the extension or paste plain cart text.");
    } else {
      setMessage("No cards or sellers detected. Paste the full Cardmarket cart or import from the extension.");
    }
    updateWorkflowStatus("Parse failed", "warning", "Try again with the complete cart.");
    updateOptimizeButton();
    render();
    return;
  }
  const sourceText = imported.ok
    ? "Cart received from Cardmarket. No copy-paste required."
    : "Cart detected. No spreadsheet required.";
  const shippingDetected = state.parsed.sellers.some((seller) => seller.shippingMethod || Number.isFinite(Number(seller.shippingValue)));
  setMessage(`${sourceText} We found ${state.parsed.sellerCount} seller(s), ${offerGroups.length} card(s), ${totalCopies} total copies. Shipping data ${shippingDetected ? "was" : "was not"} detected.${warningText}`);
  if (!autoReveal && imported.ok) {
    updateWorkflowStatus("Ready to review", state.parsed.warnings.length ? "warning" : "good", "Click Review cart to open Step 2.");
  } else {
    updateWorkflowStatus("Ready", state.parsed.warnings.length ? "warning" : "good", "Review cards and quantities, then optimize your buy plan.");
  }
  updateOptimizeButton();
  render();

  // Trigger async Scryfall enrichment (non-blocking)
  if (state.referenceCheckEnabled && state.parsed.sellers.length > 0) {
    const lookupToken = state.activeReferenceLookupToken;
    enrichParserResultsWithScryfall(state.parsed.sellers, lookupToken).catch(error => {
      console.error('Scryfall enrichment failed:', error);
    });
  }
}

function inferSellerCountryFromShippingMethod(sellers) {
  if (!state.shippingData) {
    return;
  }
  const shippingIndex = buildShippingIndex(state.shippingData);
  if (!shippingIndex.length) {
    return;
  }
  sellers.forEach(seller => {
    if (seller.sellerCountry && seller.sellerCountry !== "Unknown") {
      return;
    }
    if (!seller.shippingMethod) {
      return;
    }
    const shippingVal = (seller.shippingValue !== undefined && seller.shippingValue !== null)
      ? Number(seller.shippingValue)
      : null;
    const inference = inferSellerCountry(
      seller.shippingMethod,
      shippingVal,
      seller.trackingStatus || "unknown",
      shippingIndex
    );
    if (inference.confidence >= 0.9 && !inference.ambiguous && inference.country) {
      console.info(`[Kaikata] Inferred country "${inference.country}" for seller "${seller.sellerName}" from shipping method`);
      seller.sellerCountry = inference.country;
      seller.countrySource = "inferred";
      seller.countryInference = inference;
    } else {
      console.info(`[Kaikata] Could not confidently infer country for seller "${seller.sellerName}" (confidence: ${inference.confidence}, ambiguous: ${inference.ambiguous})`);
    }
  });
}

/**
 * Asynchronously enrich parsed cards with Scryfall reference prices
 *
 * @param {array} sellers - Array of seller objects from parsed cart
 * @param {number} lookupToken - Parse-scoped token to ignore stale async responses
 */
async function enrichParserResultsWithScryfall(sellers, lookupToken) {
  state.scryallLookupInProgress = true;
  render(); // Show loading state

  try {
    // Extract unique card names from all sellers
    const cardNames = new Set();
    sellers.forEach(seller => {
      seller.items.forEach(item => {
        if (item.cardName) {
          cardNames.add(item.cardName);
        }
      });
    });

    if (cardNames.size === 0) {
      return; // No cards to look up
    }

    // Bulk lookup with Scryfall
    const references = await enrichCardsWithReferencePrices([...cardNames]);

    if (lookupToken !== state.activeReferenceLookupToken) {
      return;
    }

    // Store in state, keyed by normalized name
    references.forEach((refData, normalizedKey) => {
      state.priceReferences[normalizedKey] = refData;
    });

  } catch (error) {
    console.error('Scryfall lookup failed:', error);
    // Don't break the app - just skip reference prices
  } finally {
    if (lookupToken !== state.activeReferenceLookupToken) {
      return;
    }
    state.scryallLookupInProgress = false;
    render(); // Update UI with reference prices

    // Ensure all reference tooltips are updated with loaded data
    updateReferenceTooltips();
  }
}

function clearInput() {
  elements.cartInput.value = "";
  state.parsed = parseCart("");
  state.optimizationResult = null;
  state.inputCollapsed = false;
  state.desiredQuantityByCard = {};
  state.optimizationStale = false;
  state.expandedCards = new Set();
  state.variantPreferences = {};
  state.priceReferences = {}; // Clear reference prices
  state.scryallLookupInProgress = false;
  state.activeReferenceLookupToken += 1;
  state.inputSource = "manual";
  state.showManualFallback = false;
  state.lastImportedFingerprint = "";
  state.reviewUnlocked = false;
  state.cardmarketCartUrl = null;
  if (elements.parseButton) elements.parseButton.classList.remove("hidden");
  elements.desiredCardsSection?.removeAttribute("open");
  setMessage("Paste your Cardmarket cart. We'll handle the seller math.");
  updateWorkflowStatus("Ready to parse", "muted", "Next: review the detected cards and quantities.");
  render();
}

function render() {
  const sellers = state.parsed.sellers || [];
  const itemCount = sellers.reduce((sum, seller) => sum + seller.items.length, 0);
  const offerGroups = buildOfferGroups(sellers);
  const parsedTotal = sellers.reduce((sum, seller) => sum + Number(seller.total || 0), 0);
  const hasParsedData = sellers.length > 0;
  const hasOptimization = Boolean(state.optimizationResult);

  const showReviewStep = hasParsedData && state.reviewUnlocked;
  elements.desiredCardsSection?.classList.toggle("hidden", !showReviewStep);
  if (showReviewStep && elements.desiredCardsSection) {
    elements.desiredCardsSection.classList.add("step-active");
    // Remove accent on first click
    const removeAccent = () => {
      elements.desiredCardsSection?.classList.remove("step-active");
      elements.desiredCardsSection?.removeEventListener("click", removeAccent);
    };
    elements.desiredCardsSection.addEventListener("click", removeAccent);
  }
  elements.summarySection?.classList.toggle("hidden", !hasOptimization);
  elements.recommendationSection?.classList.toggle("hidden", !hasOptimization);

  renderStepper(sellers);
  renderInputCopy();
  renderInputState(sellers, parsedTotal, offerGroups);
  renderSummary(sellers, itemCount, offerGroups, parsedTotal);
  renderDesiredCards(offerGroups);
  renderOptimizationViews();
}

function renderInputCopy() {
  if (!elements.inputHeading || !elements.inputDescription) {
    return;
  }
  if (elements.inputEyebrow) {
    elements.inputEyebrow.textContent = "STEP 1 — IMPORT";
  }
  elements.inputHeading.textContent = "Import Your Cart";
  elements.inputDescription.textContent = "Paste your Cardmarket cart text or import from the extension.";
}

function renderStepper(sellers) {
  const stepper = document.querySelector("#appStepper");
  if (!stepper) return;

  const hasParsedData = sellers.length > 0;
  const hasResult = !!state.optimizationResult;

  let activeStep = 1;
  if (hasResult) {
    activeStep = 3;
  } else if (hasParsedData && state.reviewUnlocked) {
    activeStep = 2;
  }

  stepper.querySelectorAll(".stepper-item").forEach((item) => {
    const step = Number(item.dataset.step);
    item.classList.remove("active", "done");
    if (step < activeStep) {
      item.classList.add("done");
    } else if (step === activeStep) {
      item.classList.add("active");
    }
  });

  stepper.querySelectorAll(".stepper-line").forEach((line) => {
    const fromStep = Number(line.dataset.from);
    line.classList.toggle("done", fromStep < activeStep);
  });
}

function formatExtractedAtClock(iso) {
  if (!iso || typeof iso !== "string") {
    return "";
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function renderExtensionImportSection(sellers, offerGroups) {
  const cardEl = elements.extensionImportCard;
  const wrap = elements.cartInputFieldWrap;
  const toggleSlot = elements.extensionManualFallbackToggle;
  if (!cardEl || !wrap) {
    return;
  }

  if (toggleSlot) {
    toggleSlot.classList.add("hidden");
    toggleSlot.innerHTML = "";
  }

  const isExtension = state.inputSource === "extension";
  const parseOk = sellers.length > 0;

  if (!isExtension) {
    cardEl.classList.add("hidden");
    cardEl.innerHTML = "";
    wrap.classList.remove("hidden");
    return;
  }

  const showSuccessCard = parseOk && !state.showManualFallback;
  const showFailCard = !parseOk;
  const showTextarea = showFailCard || state.showManualFallback;

  wrap.classList.toggle("hidden", !showTextarea);

  const sellerCount = sellers.length;
  const cardTypes = offerGroups.length;
  const totalCopies = getTotalCopies(offerGroups);
  const clock = formatExtractedAtClock(state.parsed.extractedAt || "");
  const summaryParts = [
    `${sellerCount} seller${sellerCount === 1 ? "" : "s"}`,
    `${cardTypes} card${cardTypes === 1 ? "" : "s"}`,
    `${totalCopies} total copies`
  ];
  if (clock) {
    summaryParts.push(`extracted at ${clock}`);
  }
  const summaryLine = summaryParts.join(" · ");

  if (showSuccessCard) {
    cardEl.classList.remove("hidden");
    cardEl.innerHTML = `
      <div class="input-summary-card panel" role="region" aria-label="Extension import status">
        <div class="input-summary-copy">
          <span class="status-pill good">${escapeHtml("Cart received")}</span>
          <h3>${escapeHtml("Import Your Cart")}</h3>
          <p>${escapeHtml(summaryLine)}</p>
          <button type="button" class="ghost-button extension-import-toggle" data-action="toggle-extension-manual">${escapeHtml("Paste manually instead ↓")}</button>
        </div>
      </div>
    `;
    const revealBtn = cardEl.querySelector("[data-action=\"toggle-extension-manual\"]");
    revealBtn?.addEventListener("click", () => {
      state.showManualFallback = true;
      render();
    });
    return;
  }

  cardEl.classList.add("hidden");
  cardEl.innerHTML = "";

  if (showFailCard) {
    cardEl.classList.remove("hidden");
    cardEl.innerHTML = `
      <div class="input-summary-card panel" role="alert">
        <div class="input-summary-copy">
          <span class="status-pill warning">${escapeHtml("Import failed")}</span>
          <p>${escapeHtml("Kaikata couldn't read the cart data. Try importing again or paste manually below.")}</p>
        </div>
      </div>
    `;
    return;
  }

  if (parseOk && state.showManualFallback && toggleSlot) {
    toggleSlot.classList.remove("hidden");
    toggleSlot.innerHTML = `<button type="button" class="ghost-button extension-import-toggle" data-action="hide-extension-manual">${escapeHtml("Hide raw data ↑")}</button>`;
    toggleSlot.querySelector("[data-action=\"hide-extension-manual\"]")?.addEventListener("click", () => {
      state.showManualFallback = false;
      render();
    });
  }
}

function renderInputState(sellers, parsedTotal, offerGroups) {
  const canCollapse = state.inputCollapsed && state.optimizationResult && sellers.length;
  elements.inputEditor.classList.toggle("hidden", Boolean(canCollapse));
  elements.inputSummary.classList.toggle("hidden", !canCollapse);

  if (!canCollapse) {
    elements.inputSummary.innerHTML = "";
    renderExtensionImportSection(sellers, offerGroups);
    // Hide "Review cart" when extension import succeeded — Step 2 is already revealed
    const isExtensionSuccess = state.inputSource === "extension"
      && sellers.length > 0
      && !state.showManualFallback;
    if (elements.parseButton) {
      elements.parseButton.classList.toggle("hidden", isExtensionSuccess);
    }
    return;
  }

  if (elements.extensionImportCard) {
    elements.extensionImportCard.innerHTML = "";
    elements.extensionImportCard.classList.add("hidden");
  }
  if (elements.cartInputFieldWrap) {
    elements.cartInputFieldWrap.classList.remove("hidden");
  }
  if (elements.extensionManualFallbackToggle) {
    elements.extensionManualFallbackToggle.classList.add("hidden");
    elements.extensionManualFallbackToggle.innerHTML = "";
  }

  elements.inputSummary.innerHTML = `
    <div class="input-summary-card">
      <div class="input-summary-copy">
        <span class="status-pill good">Cart parsed</span>
        <h3>Shopping list ready</h3>
        <p>${escapeHtml(`${sellers.length} seller${sellers.length === 1 ? "" : "s"} detected, ${state.parsed.itemCount} offer${state.parsed.itemCount === 1 ? "" : "s"} parsed, original total ${formatMoney(parsedTotal)}.`)}</p>
      </div>
      <div class="button-row input-summary-actions">
        <button id="editCartButton" class="ghost-button" type="button">${state.inputSource === "extension" ? "Replace Imported Cart" : "Edit Pasted Cart"}</button>
        <button id="clearButtonCompact" class="ghost-button" type="button">Clear</button>
      </div>
    </div>
  `;

  elements.editCartButton = document.querySelector("#editCartButton");
  if (elements.editCartButton) {
    elements.editCartButton.addEventListener("click", () => {
      state.inputCollapsed = false;
      render();
    });
  }

  const compactClear = document.querySelector("#clearButtonCompact");
  if (compactClear) {
    compactClear.addEventListener("click", clearInput);
  }
}

function renderSummary(sellers, itemCount, offerGroups, parsedTotal) {
  const ambiguousCount = sellers.filter((seller) => seller.countryInference?.ambiguous).length;
  const unknownCountryCount = sellers.filter((seller) => !seller.sellerCountry || seller.sellerCountry === "Unknown").length;
  const pricedOfferCount = sellers.reduce((sum, seller) => sum + seller.items.filter((item) => Number.isFinite(Number(item.price))).length, 0);
  const warningCount = ambiguousCount + unknownCountryCount + state.parsed.warnings.length;

  const inputSourceLabel = state.inputSource === "extension" ? "Extension import" : "Manual paste";
  const shippingDetected = sellers.some((seller) => seller.shippingMethod || Number.isFinite(Number(seller.shippingValue)));
  if (elements.summaryStrip) {
    elements.summaryStrip.innerHTML = [
      summaryCard(sellers.length ? "Parsed successfully" : "Waiting for cart", sellers.length ? "Ready" : "Idle", sellers.length ? "good" : "muted"),
      summaryCard("Input source", inputSourceLabel, state.inputSource === "extension" ? "good" : "muted"),
      summaryCard("Sellers", sellers.length, sellers.length ? "good" : "muted"),
      summaryCard("Offers", itemCount, itemCount ? "good" : "muted"),
      summaryCard("Total copies", getTotalCopies(offerGroups), itemCount ? "good" : "muted"),
      summaryCard("Shipping detected", shippingDetected ? "Yes" : "No", shippingDetected ? "good" : "warning"),
      summaryCard("Prices found", pricedOfferCount, pricedOfferCount ? "good" : "muted"),
      summaryCard("Shipping data", state.shippingData ? "Ready" : "Missing", state.shippingData ? "good" : "warning"),
      summaryCard("Warnings", warningCount ? `${warningCount} to review` : "Clear", warningCount ? "warning" : "good")
    ].join("");
  }
}

function summaryCard(label, value, tone = "muted") {
  return `
    <div class="summary-card summary-card-${escapeAttribute(tone)}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderOptimizationViews() {
  if (!state.optimizationResult) {
    elements.optimizationSummary.innerHTML = "";
    elements.optimizationNotes.innerHTML = "";
    elements.notesPanel.classList.add("hidden");
    elements.optimizationOutput.innerHTML = "";
    if (elements.advancedDetails?.parentElement) {
      const advancedSection = elements.advancedDetails.parentElement;
      advancedSection.classList.add("hidden");
    }
    return;
  }

  elements.optimizationSummary.innerHTML = optimizationSummaryTemplate(state.optimizationResult);
  elements.optimizationSummary.querySelector("#confirmPlanButton")?.addEventListener("click", handleConfirmPlan);
  const warningEntries = buildResultWarnings(state.optimizationResult);

  let notesContent = "";
  if (warningEntries.length) {
    notesContent = warningBannerTemplate(state.optimizationResult, warningEntries);
  }
  elements.optimizationNotes.innerHTML = notesContent;
  elements.notesPanel.classList.toggle("hidden", notesContent.length === 0);

  elements.optimizationOutput.innerHTML = recommendationsTemplate(state.optimizationResult);

  const offerGroups = buildOfferGroups(state.parsed.sellers);
  const advancedContent = advancedDetailsTemplate(state.optimizationResult, offerGroups);
  if (elements.advancedDetails) {
    elements.advancedDetails.innerHTML = advancedContent;
    const advancedSection = elements.advancedDetails.parentElement;
    advancedSection.classList.toggle("hidden", !advancedContent.trim());
  }

  attachUnresolvedResolverHandlers();
}

function renderDesiredCards(offerGroups) {
  elements.desiredCardsReview.innerHTML = "";

  if (!offerGroups.length) {
    return;
  }
  elements.desiredCardsSection?.setAttribute("open", "true");

  const detectedTotal = Object.values(state.desiredQuantityByCard).reduce((sum, qty) => sum + qty, 0);
  const selectedTotal = Object.values(state.desiredQuantityByCard).filter(qty => qty > 0).length;
  const actionLabel = state.optimizationStale || !state.optimizationResult ? "Optimize your cart" : "Re-optimize your cart";

  elements.desiredCardsReview.insertAdjacentHTML("beforeend", `
    <div class="review-action-bar">
      <div class="review-action-copy review-action-pills">
        <span class="status-pill info">${escapeHtml(`${selectedTotal} Cards`)}</span>
        <span class="status-pill muted">${escapeHtml(`${detectedTotal} Total Copies`)}</span>
        <span class="status-pill muted">Best cart total beats best single-card prices</span>
      </div>
      <div class="review-cta-group">
        <button id="runOptimizationButton" class="primary-button run-button" type="button">${escapeHtml(actionLabel)}</button>
      </div>
    </div>
    ${referenceStatusTemplate()}
    ${desiredCardsTableTemplate(offerGroups)}
  `);

  elements.runOptimizationButton = document.querySelector("#runOptimizationButton");
  elements.runOptimizationButton?.addEventListener("click", runOptimizationPlaceholder);

  const cardSearchInput = document.querySelector("#cardSearchInput");
  const cardCountBadge = document.querySelector("#cardCountBadge");
  if (cardSearchInput) {
    cardSearchInput.addEventListener("input", (e) => {
      const query = e.target.value.toLowerCase();
      const cards = document.querySelectorAll(".card-accordion");
      let visibleCount = 0;

      cards.forEach((card) => {
        const name = (card.dataset.cardName || "").toLowerCase();
        const isMatch = name.includes(query);
        card.style.display = isMatch ? "" : "none";
        if (isMatch) visibleCount += 1;
      });

      if (cardCountBadge) {
        cardCountBadge.textContent = `${visibleCount}/${offerGroups.length} cards`;
      }
    });
  }
}

function desiredCardsTableTemplate(offerGroups) {
  const cardCount = offerGroups.length;
  return `
    <section class="panel desired-cards-panel">
      <div class="desired-cards-toolbar">
        <input type="text" id="cardSearchInput" class="card-search-input" placeholder="Search cards" aria-label="Search cards">
        <div class="card-count-badge" id="cardCountBadge">${cardCount} cards</div>
      </div>
      <div class="card-accordion-list" role="list">
        ${offerGroups.map(desiredCardTemplate).join("")}
      </div>
    </section>
  `;
}

function desiredCardTemplate(group) {
  const cardName = group.cardName;
  const desiredQty = state.desiredQuantityByCard[cardName] ?? group.requiredQuantity;
  const isAvailable = group.requiredQuantity >= desiredQty;
  const statusLabel = desiredQty === 0 ? "Excluded" : isAvailable ? "Ready" : "Needs review";
  const statusClass = desiredQty === 0 ? "muted" : isAvailable ? "good" : "warning";
  const isExpanded = state.expandedCards.has(cardName);
  const prefLabel = hasAnyPreference(cardName) ? "Preferences set" : "Any version";

  const copiesWord = desiredQty === 1 ? "copy" : "copies";
  const variantWord = group.variantCount === 1 ? "variant" : "variants";
  const variantHint = group.variantCount > 1
    ? `${desiredQty} ${copiesWord} · ${group.variantCount} ${variantWord} detected · ${prefLabel}`
    : `${desiredQty} ${copiesWord} · ${prefLabel}`;

  const hasRange = group.highestUnitPrice > group.lowestUnitPrice + 0.005;
  const priceHint = hasRange
    ? `Lowest: ${formatMoney(group.lowestUnitPrice)} · Range: ${formatMoney(group.lowestUnitPrice)}–${formatMoney(group.highestUnitPrice)}`
    : `${formatMoney(group.lowestUnitPrice)}`;

  return `
    <div class="card-accordion ${isExpanded ? "is-expanded" : ""}" data-card-name="${escapeAttribute(cardName)}" role="listitem">
      <div class="card-accordion-header" data-action="toggle-card" role="button" tabindex="0" aria-expanded="${isExpanded}">
        <div class="card-accordion-info">
          <span class="card-name-label">${escapeHtml(cardName)}</span>
          <span class="card-variant-hint">${escapeHtml(variantHint)}</span>
          <span class="card-price-hint">${escapeHtml(priceHint)}</span>
        </div>
        <div class="card-accordion-controls">
          <span class="status-pill ${statusClass}">${escapeHtml(statusLabel)}</span>
          <div class="card-qty-group">
            <button class="qty-button" data-action="decrement-qty" aria-label="Decrease ${escapeAttribute(cardName)} quantity">−</button>
            <input class="qty-input" type="number" data-card-qty data-action="noop" min="0" step="1" value="${desiredQty}" aria-label="Copies of ${escapeAttribute(cardName)}">
            <button class="qty-button" data-action="increment-qty" aria-label="Increase ${escapeAttribute(cardName)} quantity">+</button>
          </div>
        </div>
        <span class="card-chevron" aria-hidden="true">▾</span>
      </div>
      ${isExpanded ? variantBodyTemplate(group) : ""}
    </div>
  `;
}

function variantBodyTemplate(group) {
  const variantMap = new Map();
  group.offers.forEach((offer) => {
    const vk = makeVariantKey(offer);
    if (!variantMap.has(vk)) {
      variantMap.set(vk, { ...offer, allSellers: [] });
    }
    variantMap.get(vk).allSellers.push(offer.sellerName);
  });

  const variants = [...variantMap.entries()];
  const hasEnriched = variants.some(([, v]) => v.setName || v.collectorNumber || v.language);
  const showRef = state.referenceCheckEnabled;

  return `
    <div class="card-accordion-body">
      <p class="variant-section-title">Detected Variants ${tooltipChip("Unless you set Prefer, Require, or Exclude, Kaikata optimizes by lowest total cart cost.")}</p>
      <div class="variant-table-wrap">
        <table class="variant-table">
          ${variantColumnGroupTemplate(hasEnriched, showRef)}
          <thead>
            <tr>
              ${hasEnriched ? `<th class="variant-col-set">Set</th><th class="variant-col-number">#</th><th class="variant-col-lang">Lang</th>` : ""}
              <th>Condition</th>
              <th>Qty</th>
              <th>Price</th>
              ${showRef ? `<th>Ref.</th><th>Δ</th>` : ""}
              <th>Seller</th>
              <th>Preference</th>
            </tr>
          </thead>
          <tbody>
            ${variants.map(([vk, v]) => variantRowTemplate(group.cardName, vk, v, hasEnriched, showRef)).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function variantColumnGroupTemplate(hasEnriched, showRef) {
  return `
    <colgroup>
      ${hasEnriched ? `<col class="variant-col-set"><col class="variant-col-number"><col class="variant-col-lang">` : ""}
      <col class="variant-col-condition">
      <col class="variant-col-qty">
      <col class="variant-col-price">
      ${showRef ? `<col class="variant-col-ref"><col class="variant-col-delta">` : ""}
      <col class="variant-col-seller">
      <col class="variant-col-preference">
    </colgroup>
  `;
}

function variantRowTemplate(cardName, variantKey, offer, hasEnriched, showRef) {
  const pref = (state.variantPreferences[cardName] || {})[variantKey] || "any";
  const prefClass = pref === "require" ? "pref-require" : pref === "prefer" ? "pref-prefer" : pref === "exclude" ? "pref-exclude" : "";
  const sellers = offer.allSellers ? [...new Set(offer.allSellers)].join(", ") : offer.sellerName || "";

  let refCells = "";
  if (showRef) {
    const refData = getReferenceData(offer.cardName);
    const selectedPrice = Number(offer.unitPrice);
    const referencePrice = Number(refData?.price);
    const delta = Number.isFinite(selectedPrice) && Number.isFinite(referencePrice)
      ? calculatePriceDelta(selectedPrice, referencePrice)
      : null;
    const deltaColor = getDeltaColor(delta?.percentage);
    const deltaDisplay = formatDeltaDisplay(delta?.percentage);
    const refPrice = state.scryallLookupInProgress && !refData
      ? `<span class="reference-muted">Loading…</span>`
      : refData && !refData.error
        ? escapeHtml(formatReferenceMoney(refData.price, refData.currency))
        : `<span class="reference-muted">—</span>`;
    const refDelta = refData && !refData.error && delta
      ? `<span class="reference-delta-badge delta-${escapeAttribute(deltaColor)}" title="${escapeAttribute(`${formatMoney(selectedPrice)} vs ${formatReferenceMoney(referencePrice, refData.currency)} from ${refData.source || "Scryfall"}`)}">${escapeHtml(deltaDisplay)}</span>`
      : `<span class="reference-muted">—</span>`;
    refCells = `<td class="price-cell">${refPrice}</td><td class="price-cell">${refDelta}</td>`;
  }

  return `
    <tr class="${prefClass}" data-variant-key="${escapeAttribute(variantKey)}">
      ${hasEnriched ? `
        <td>${escapeHtml(offer.setName || "—")}</td>
        <td>${escapeHtml(offer.collectorNumber || "—")}</td>
        <td>${escapeHtml(offer.language || "—")}</td>
      ` : ""}
      <td>${escapeHtml(offer.condition || "Unknown")}</td>
      <td>${escapeHtml(String(offer.quantity))}</td>
      <td class="price-cell">${escapeHtml(formatMoney(offer.unitPrice))}</td>
      ${refCells}
      <td class="variant-seller-cell">${escapeHtml(sellers)}</td>
      <td>
        <select class="variant-pref-select" data-variant-pref data-variant-key="${escapeAttribute(variantKey)}" aria-label="Preference for this version">
          <option value="any" ${pref === "any" ? "selected" : ""}>Any version</option>
          <option value="prefer" ${pref === "prefer" ? "selected" : ""}>Prefer this</option>
          <option value="require" ${pref === "require" ? "selected" : ""}>Require this</option>
          <option value="exclude" ${pref === "exclude" ? "selected" : ""}>Exclude</option>
        </select>
      </td>
    </tr>
  `;
}

function referenceStatusTemplate() {
  if (!state.referenceCheckEnabled) {
    return "";
  }

  if (state.scryallLookupInProgress) {
    return `<p class="note-text reference-status-text">Checking sellers, shipping, and stack-sized cart math…</p>`;
  }

  const referenceCount = Object.values(state.priceReferences).filter((entry) => entry && !entry.error).length;
  if (referenceCount > 0) {
    return `<p class="note-text reference-status-text">Reference prices are for context only; optimization still follows Cardmarket costs.</p>`;
  }

  return "";
}

function referencePriceDisplay(referenceData) {
  if (state.scryallLookupInProgress && !referenceData) {
    return `<span class="reference-muted">Loading...</span>`;
  }

  if (!referenceData) {
    return `<span class="reference-muted">Pending</span>`;
  }

  if (referenceData.error) {
    return `<span class="reference-muted">Unavailable</span>`;
  }

  return `<span class="price-with-reference">${escapeHtml(formatReferenceMoney(referenceData.price, referenceData.currency))}</span>`;
}

function referenceDeltaDisplay(referenceCard, referenceData) {
  if (state.scryallLookupInProgress && !referenceData) {
    return `<span class="reference-muted">Loading...</span>`;
  }

  if (!referenceData) {
    return `<span class="reference-muted">-</span>`;
  }

  if (referenceData.error || !referenceCard.hasReference) {
    return `<span class="price-with-reference"><span class="reference-muted">-</span>${tooltipChip(referenceErrorLabel(referenceData.reason || "unknown"))}</span>`;
  }

  return `<span class="price-with-reference"><span class="reference-delta-badge delta-${escapeAttribute(referenceCard.deltaColor)}" data-card-name="${escapeAttribute(referenceCard.cardName)}" data-price="${escapeAttribute(String(referenceCard.price))}">${escapeHtml(referenceCard.deltaDisplay)}</span>${tooltipChip(referenceDeltaTitle(referenceCard, referenceData))}</span>`;
}

function offerMatrixTemplate(offerGroups) {
  return `
    <section class="panel offer-matrix-panel">
      <div class="panel-heading">
        <h2>Card Offer Matrix</h2>
        <span class="status-pill muted">Optimizer input</span>
      </div>
      <div class="offer-matrix-wrap">
        <table class="offer-matrix-table">
          <thead>
            <tr>
              <th>Required card</th>
              <th>Review qty</th>
              <th>Seller options</th>
              <th>Lowest unit</th>
              <th>Offers</th>
            </tr>
          </thead>
          <tbody>
            ${offerGroups.map(offerGroupRowTemplate).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function offerGroupRowTemplate(group) {
  return `
    <tr>
      <td>${escapeHtml(group.cardName)}</td>
      <td>${escapeHtml(group.requiredQuantity)}</td>
      <td>${escapeHtml(group.sellerCount)}</td>
      <td>${escapeHtml(formatMoney(group.lowestUnitPrice))}</td>
      <td>
        <div class="offer-chip-list">
          ${group.offers.map((offer) => `
            <span class="offer-chip">${escapeHtml(offer.sellerName)}: ${escapeHtml(offer.quantity)}x ${escapeHtml(offer.condition)} @ ${escapeHtml(formatMoney(offer.unitPrice))}</span>
          `).join("")}
        </div>
      </td>
    </tr>
  `;
}

function sellerSummaryTableTemplate(sellers) {
  return `
    <section class="panel review-table-panel">
      <div class="panel-heading">
        <h2>Seller Review Table</h2>
        <span class="status-pill muted">Editable</span>
      </div>
      <div class="seller-summary-wrap">
        <table class="seller-summary-table">
          <thead>
            <tr>
              <th>Seller name</th>
              <th>Inferred country</th>
              <th>Shipping method</th>
              <th>Tracked</th>
              <th>Article value</th>
              <th>Shipping cost</th>
              <th>Trustee cost</th>
              <th>Total</th>
              <th>Ambiguity warning</th>
            </tr>
          </thead>
          <tbody>
            ${sellers.map((seller, sellerIndex) => sellerSummaryRowTemplate(seller, sellerIndex)).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function sellerSummaryRowTemplate(seller, sellerIndex) {
  const inference = seller.countryInference || {};
  const inferenceLabel = seller.countrySource === "explicit"
    ? "Explicit country"
    : inference.ambiguous
      ? "Ambiguous shipping"
      : inference.country
        ? "Inferred country"
        : "Country review";
  const inferenceClass = inference.ambiguous || !seller.sellerCountry || seller.sellerCountry === "Unknown" ? "warning" : "good";
  const warning = inference.ambiguous
    ? "Multiple country matches"
    : !seller.sellerCountry || seller.sellerCountry === "Unknown"
      ? "Country unknown"
      : "";

  return `
    <tr data-seller-index="${sellerIndex}">
      <td>
        <input data-field="sellerName" value="${escapeAttribute(seller.sellerName)}" aria-label="Seller name">
        ${seller.sellerType ? `<span class="item-meta-badge">${escapeHtml(seller.sellerType)}</span>` : ""}
      </td>
      <td><span class="seller-field-label">${escapeHtml(seller.sellerCountry || "Unknown")}</span></td>
      <td><span class="seller-field-label">${escapeHtml(seller.shippingMethod || "—")}</span></td>
      <td><span class="seller-field-label">${escapeHtml(seller.trackingStatus || "unknown")}</span></td>
      <td><input data-field="articleValue" value="${escapeAttribute(moneyInputValue(seller.articleValue))}" aria-label="Article value"></td>
      <td><input data-field="shippingValue" value="${escapeAttribute(moneyInputValue(seller.shippingValue))}" aria-label="Shipping cost"></td>
      <td><input data-field="trusteeValue" value="${escapeAttribute(moneyInputValue(seller.trusteeValue))}" aria-label="Trustee cost"></td>
      <td><input data-field="total" value="${escapeAttribute(moneyInputValue(seller.total))}" aria-label="Total"></td>
      <td><span class="status-pill ${inferenceClass}">${escapeHtml(warning || inferenceLabel)}</span></td>
    </tr>
  `;
}

function sellerItemBreakdownTemplate(seller, sellerIndex) {
  const inference = seller.countryInference || {};
  const inferenceLabel = seller.countrySource === "explicit"
    ? "Explicit country"
    : inference.ambiguous
      ? "Ambiguous shipping"
      : inference.country
        ? "Inferred country"
        : "Country review";
  const inferenceClass = inference.ambiguous || !seller.sellerCountry || seller.sellerCountry === "Unknown" ? "warning" : "good";

  return `
    <div class="seller-header">
      <div class="seller-title">
        <span class="eyebrow">Seller ${sellerIndex + 1}</span>
        <h3>${escapeHtml(seller.sellerName)}</h3>
      </div>
      <div class="seller-chips">
        <span class="status-pill ${inferenceClass}">${escapeHtml(inferenceLabel)}</span>
        <span class="status-pill info">${escapeHtml(seller.trackingStatus || "unknown")}</span>
        ${seller.sellerType ? `<span class="status-pill muted">${escapeHtml(seller.sellerType)}</span>` : ""}
        <span class="status-pill muted">${seller.items.length} item(s)</span>
      </div>
    </div>
    ${matchPanelTemplate(seller)}
    <div class="table-toolbar">
      <h3>Item Rows</h3>
      <button class="ghost-button" type="button" data-action="add-item">Add Row</button>
    </div>
    <div class="item-table-wrap">
      <table class="item-table">
        <thead>
          <tr>
            <th>Card</th>
            <th>Set</th>
            <th>Rarity</th>
            <th class="condition-cell">Condition</th>
            <th class="qty-cell">Qty</th>
            <th class="price-cell">Price</th>
            <th>Seller</th>
            <th>Raw</th>
            <th class="actions-cell"></th>
          </tr>
        </thead>
        <tbody>
          ${seller.items.map((item, itemIndex) => itemRowTemplate(item, itemIndex, seller.sellerName)).join("")}
        </tbody>
      </table>
    </div>
    <pre class="raw-block ${state.showDebug ? "" : "hidden"}">${escapeHtml(seller.rawText)}</pre>
  `;
}

function fieldTemplate(label, field, value) {
  return `
    <label class="field">
      <span>${escapeHtml(label)}</span>
      <input data-field="${escapeAttribute(field)}" value="${escapeAttribute(value ?? "")}">
    </label>
  `;
}

function selectFieldTemplate(label, field, value, options) {
  return `
    <label class="field">
      ${label ? `<span>${escapeHtml(label)}</span>` : ""}
      <select data-field="${escapeAttribute(field)}">
        ${options.map((option) => `<option value="${escapeAttribute(option)}" ${option === value ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}
      </select>
    </label>
  `;
}

function matchPanelTemplate(seller) {
  const matches = seller.countryInference?.matches || [];
  if (!matches.length) {
    return "";
  }

  return `
    <div class="match-panel">
      <h3>Shipping Matches</h3>
      <div class="match-list">
        ${matches.map((match) => `
          <button class="match-button" type="button" data-action="apply-match" data-country="${escapeAttribute(match.country)}" data-method="${escapeAttribute(match.method)}">
            ${escapeHtml(match.country)} / ${escapeHtml(match.method || "Method")} (${Math.round(match.score * 100)}%)
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

function itemRowTemplate(item, itemIndex, sellerName) {
  return `
    <tr data-item-index="${itemIndex}">
      <td>
        <input data-item-field="cardName" value="${escapeAttribute(item.cardName)}" aria-label="Card name">
        ${item.language ? `<span class="item-meta-badge lang-badge">${escapeHtml(item.language)}</span>` : ""}
      </td>
      <td>
        <input data-item-field="setName" value="${escapeAttribute(item.setName || "")}" aria-label="Set">
        ${item.collectorNumber ? `<span class="item-meta-badge coll-badge">${escapeHtml(item.collectorNumber)}</span>` : ""}
      </td>
      <td><input data-item-field="rarity" value="${escapeAttribute(item.rarity || "")}" aria-label="Rarity"></td>
      <td class="condition-cell">
        <span class="condition-label">${escapeHtml(item.condition || "Unknown")}</span>
      </td>
      <td class="qty-cell"><input data-item-field="quantity" type="number" min="1" step="1" value="${escapeAttribute(item.quantity)}" aria-label="Quantity"></td>
      <td class="price-cell"><input data-item-field="price" value="${escapeAttribute(moneyInputValue(item.price))}" aria-label="Price"></td>
      <td><input value="${escapeAttribute(sellerName || "")}" aria-label="Seller" disabled></td>
      <td><input data-item-field="rawLine" value="${escapeAttribute(item.rawLine || "")}" aria-label="Raw row"></td>
      <td class="actions-cell"><button class="icon-button" type="button" data-action="delete-item" title="Delete Row" aria-label="Delete Row">x</button></td>
    </tr>
  `;
}

function handleReviewChange(event) {
  const sellerScope = event.target.closest("[data-seller-index]");
  if (!sellerScope) {
    return;
  }

  const sellerIndex = Number.parseInt(sellerScope.dataset.sellerIndex, 10);
  const seller = state.parsed.sellers[sellerIndex];
  const itemRow = event.target.closest("[data-item-index]");

  if (itemRow && event.target.dataset.itemField) {
    const itemIndex = Number.parseInt(itemRow.dataset.itemIndex, 10);
    const item = seller.items[itemIndex];
    const field = event.target.dataset.itemField;
    item[field] = coerceItemField(field, event.target.value);
    updateOptimizationPreview();
    return;
  }

  if (event.target.dataset.field) {
    const field = event.target.dataset.field;
    const value = coerceSellerField(field, event.target.value);
    seller[field] = value;

    if (field === "sellerCountry" && value && value !== "Unknown") {
      seller.countrySource = "manual";
      seller.countryInference = {
        ...seller.countryInference,
        ambiguous: false,
        country: value,
        source: "manual"
      };
    }

    if (field === "shippingMethod") {
      seller.shippingMethodSource = "manual";
    }

    if (field === "trackingStatus") {
      seller.trackingSource = "manual";
    }

    updateOptimizationPreview();
  }
}

function handleReviewClick(event) {
  const sellerScope = event.target.closest("[data-seller-index]");
  if (!sellerScope) {
    return;
  }

  const sellerIndex = Number.parseInt(sellerScope.dataset.sellerIndex, 10);
  const seller = state.parsed.sellers[sellerIndex];
  const action = event.target.dataset.action;

  if (action === "add-item") {
    seller.items.push({
      id: `manual-${Date.now()}`,
      cardName: "New card",
      setName: "",
      rarity: "",
      condition: "Unknown",
      quantity: 1,
      price: 0,
      rawLine: "",
      warnings: ["Manual row"]
    });
    render();
    return;
  }

  if (action === "delete-item") {
    const row = event.target.closest("[data-item-index]");
    const itemIndex = Number.parseInt(row.dataset.itemIndex, 10);
    seller.items.splice(itemIndex, 1);
    render();
    return;
  }

  if (action === "apply-match") {
    seller.sellerCountry = event.target.dataset.country || "Unknown";
    seller.shippingMethod = event.target.dataset.method || seller.shippingMethod;
    seller.countrySource = "manual";
    seller.shippingMethodSource = "manual";
    render();
  }
}

function handleDesiredQuantityChange(event) {
  if (event.target.dataset.variantPref !== undefined) {
    const accordion = event.target.closest(".card-accordion");
    if (!accordion) return;
    const cardName = accordion.dataset.cardName;
    const variantKey = event.target.dataset.variantKey;
    const value = event.target.value;
    if (!state.variantPreferences[cardName]) {
      state.variantPreferences[cardName] = {};
    }
    if (value === "any") {
      delete state.variantPreferences[cardName][variantKey];
    } else {
      state.variantPreferences[cardName][variantKey] = value;
    }
    // Update row highlight
    const variantRow = event.target.closest("tr");
    if (variantRow) {
      variantRow.className = value === "require" ? "pref-require" : value === "prefer" ? "pref-prefer" : value === "exclude" ? "pref-exclude" : "";
    }
    // Update the collapsed-row variant hint
    const hintEl = accordion.querySelector(".card-variant-hint");
    if (hintEl) {
      const offerGroups = buildOfferGroups(state.parsed.sellers);
      const group = offerGroups.find((g) => g.cardName === cardName);
      const variantCount = group?.variantCount || 1;
      const desiredQty = state.desiredQuantityByCard[cardName] ?? group?.requiredQuantity ?? 1;
      const copiesWord = desiredQty === 1 ? "copy" : "copies";
      const variantWord = variantCount === 1 ? "variant" : "variants";
      const prefLabel = hasAnyPreference(cardName) ? "Preferences set" : "Any version";
      hintEl.textContent = variantCount > 1
        ? `${desiredQty} ${copiesWord} · ${variantCount} ${variantWord} detected · ${prefLabel}`
        : `${desiredQty} ${copiesWord} · ${prefLabel}`;
    }
    state.optimizationStale = true;
    updateOptimizationPreview();
    return;
  }

  if (event.target.dataset.cardQty !== undefined) {
    const row = event.target.closest("[data-card-name]");
    if (!row) return;
    const cardName = row.dataset.cardName;
    const value = Math.max(0, Number.parseInt(event.target.value, 10) || 0);
    state.desiredQuantityByCard[cardName] = value;
    state.optimizationStale = true;
    updateOptimizationPreview();
  }
}

function handleDesiredQuantityClick(event) {
  const actionEl = event.target.closest("[data-action]");
  const action = actionEl?.dataset.action;
  if (!action || action === "noop") return;

  if (action === "toggle-card") {
    const accordion = event.target.closest(".card-accordion");
    if (!accordion) return;
    const cardName = accordion.dataset.cardName;
    const isExpanded = state.expandedCards.has(cardName);
    if (isExpanded) {
      state.expandedCards.delete(cardName);
      accordion.classList.remove("is-expanded");
      accordion.querySelector(".card-accordion-body")?.remove();
      accordion.querySelector(".card-accordion-header")?.setAttribute("aria-expanded", "false");
    } else {
      state.expandedCards.add(cardName);
      accordion.classList.add("is-expanded");
      accordion.querySelector(".card-accordion-header")?.setAttribute("aria-expanded", "true");
      const offerGroups = buildOfferGroups(state.parsed.sellers);
      const group = offerGroups.find((g) => g.cardName === cardName);
      if (group) {
        accordion.querySelector(".card-accordion-header").insertAdjacentHTML("afterend", variantBodyTemplate(group));
      }
    }
    return;
  }

  const row = event.target.closest("[data-card-name]");
  if (!row) return;
  const cardName = row.dataset.cardName;
  const input = row.querySelector("[data-card-qty]");

  if (action === "increment-qty") {
    const current = state.desiredQuantityByCard[cardName] || 0;
    state.desiredQuantityByCard[cardName] = current + 1;
    state.optimizationStale = true;
    input.value = state.desiredQuantityByCard[cardName];
    updateOptimizationPreview();
  } else if (action === "decrement-qty") {
    const current = state.desiredQuantityByCard[cardName] || 0;
    state.desiredQuantityByCard[cardName] = Math.max(0, current - 1);
    state.optimizationStale = true;
    input.value = state.desiredQuantityByCard[cardName];
    updateOptimizationPreview();
  }
}

function runOptimizationPlaceholder() {
  const sellers = state.parsed.sellers || [];
  const offerGroups = buildOfferGroups(sellers);

  if (!sellers.length || !offerGroups.length) {
    state.optimizationResult = null;
    updateWorkflowStatus("No cart data", "warning", "Paste or import a Cardmarket cart to continue.");
    renderOptimizationViews();
    return;
  }

  updateWorkflowStatus("Optimizing", "muted", "Checking sellers, shipping, and the usual Cardmarket chaos…");
  state.optimizationStale = false;
  state.optimizationResult = optimizeCart(sellers, offerGroups);
  state.inputCollapsed = true;
  updateWorkflowStatus(
    state.optimizationResult.warnings.length ? "Plan needs review" : "Ready to buy",
    state.optimizationResult.warnings.length ? "warning" : "good",
    state.optimizationResult.warnings.length
      ? "Check the notes before buying."
      : "Your buy list is ready."
  );
  render();
  elements.optimizationSummary.scrollIntoView({ behavior: "smooth", block: "start" });
}

function updateOptimizationPreview() {
  state.optimizationResult = null;
  updateWorkflowStatus("Needs review", "warning", "Quantities changed. Re-optimize to update your plan.");
  elements.optimizationOutput.innerHTML = "";
  const sellers = state.parsed.sellers;
  const offerGroups = buildOfferGroups(sellers);
  renderSummary(sellers, state.parsed.itemCount, offerGroups, sellers.reduce((sum, seller) => sum + Number(seller.total || 0), 0));
  elements.notesPanel.classList.add("hidden");
}

let _unresolvedHandlerRef = null;

function attachUnresolvedResolverHandlers() {
  if (!elements.optimizationOutput) return;

  if (_unresolvedHandlerRef) {
    elements.optimizationOutput.removeEventListener("click", _unresolvedHandlerRef);
  }

  _unresolvedHandlerRef = (event) => {
    const btn = event.target.closest("[data-action='apply-unresolved']");
    if (!btn) return;

    const sellerIndex = Number(btn.dataset.sellerIndex);
    const form = btn.closest(".unresolved-fix-form");
    if (!form) return;

    const countrySelect = form.querySelector(".unresolved-country-select");
    const costInput = form.querySelector(".unresolved-cost-input");

    const seller = state.parsed.sellers[sellerIndex];
    if (!seller) return;

    if (countrySelect && countrySelect.value) {
      seller.sellerCountry = countrySelect.value;
      seller.countrySource = "manual";
    }

    const overrideRaw = costInput ? costInput.value.trim() : "";
    if (overrideRaw !== "") {
      const parsed = parseFloat(overrideRaw);
      seller.shippingCostOverride = Number.isFinite(parsed) ? parsed : null;
    } else {
      seller.shippingCostOverride = null;
    }

    const offerGroups = buildOfferGroups(state.parsed.sellers);
    state.optimizationResult = optimizeCart(state.parsed.sellers, offerGroups);
    updateWorkflowStatus("Plan updated", "good", "Shipping resolved. Review the updated plan.");
    render();

    // After render, scroll to the seller's form if it still exists (still unresolved), else to the summary
    const resolveAnchor = document.getElementById(`resolve-seller-${sellerIndex}`);
    if (resolveAnchor) {
      resolveAnchor.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      elements.optimizationSummary?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  elements.optimizationOutput.addEventListener("click", _unresolvedHandlerRef);
}

function optimizeCart(sellers, offerGroups) {
  const shippingRecords = buildShippingIndex(state.shippingData);
  const groups = offerGroups.map((group) => {
    const desiredQty = state.desiredQuantityByCard[group.cardName] ?? group.requiredQuantity;
    if (desiredQty === 0) {
      return {
        ...group,
        requiredQuantity: 0,
        desiredQuantity: 0,
        candidates: []
      };
    }
    const prefs = state.variantPreferences[group.cardName] || {};
    const hasRequire = Object.values(prefs).some((p) => p === "require");
    const eligibleOffers = group.offers.filter((offer) => {
      const pref = prefs[makeVariantKey(offer)] || "any";
      if (pref === "exclude") return false;
      if (hasRequire) return pref === "require";
      return true;
    });
    const validOffers = eligibleOffers.filter((offer) => offer.quantity >= desiredQty);
    return {
      ...group,
      requiredQuantity: desiredQty,
      desiredQuantity: desiredQty,
      candidates: (validOffers.length ? validOffers : eligibleOffers.length ? eligibleOffers : group.offers)
        .map((offer) => ({ ...offer, requiredQuantity: desiredQty }))
        .sort((a, b) => {
          const aPref = prefs[makeVariantKey(a)] || "any";
          const bPref = prefs[makeVariantKey(b)] || "any";
          if (aPref === "prefer" && bPref !== "prefer") return -1;
          if (bPref === "prefer" && aPref !== "prefer") return 1;
          return a.unitPrice - b.unitPrice;
        })
    };
  });
  const warnings = [];
  const costNotes = [];
  const insufficientGroups = groups.filter((group) => group.desiredQuantity > 0 && !group.offers.some((offer) => offer.quantity >= group.desiredQuantity));
  const incompleteGroups = groups.filter((group) => !group.offers.some((offer) => offer.quantity >= group.requiredQuantity));
  const initialOffers = buildInitialAssignment(groups, sellers, shippingRecords);
  const optimization = optimizeBySellerMoves(initialOffers, groups, sellers, shippingRecords);
  const selectedOffers = optimization.selectedOffers;
  const score = optimization.score;
  const currentTotal = estimateCurrentTotal(sellers);
  const savings = currentTotal - score.total;
  const usedSellerIndexes = new Set(selectedOffers.map((offer) => offer.sellerIndex));
  const usedSellers = sellers
    .map((seller, sellerIndex) => ({ seller, sellerIndex }))
    .filter((entry) => usedSellerIndexes.has(entry.sellerIndex));
  const droppedSellers = sellers
    .map((seller, sellerIndex) => ({ seller, sellerIndex }))
    .filter((entry) => !usedSellerIndexes.has(entry.sellerIndex) && entry.seller.items.length);
  const countryWarnings = usedSellers.filter(({ seller }) => {
    const hasManualCountry = seller.countrySource === "manual" && seller.sellerCountry && seller.sellerCountry !== "Unknown";
    return !hasManualCountry && (!seller.sellerCountry || seller.sellerCountry === "Unknown" || seller.countryInference?.ambiguous);
  });
  const unresolvedShippingCosts = score.sellerCosts.filter((cost) => !Number.isFinite(cost.totalCost));
  const costBySellerIndex = new Map(score.sellerCosts.map(c => [c.sellerIndex, c]));
  const unresolvedSellers = usedSellers.filter(({ sellerIndex }) => costBySellerIndex.get(sellerIndex)?.source === "unresolved");

  if (insufficientGroups.length) {
    insufficientGroups.forEach((group) => {
      const maxAvailable = Math.max(...group.offers.map(o => o.quantity));
      warnings.push(`⚠️ ${group.cardName}: only ${maxAvailable} available, but desired quantity is ${group.desiredQuantity}.`);
    });
  }

  if (!shippingRecords.length) {
    costNotes.push("Shipping table unavailable: optimization cannot price dynamic shipping.");
  }

  if (incompleteGroups.length) {
    costNotes.push(`${incompleteGroups.length} card(s) had no single seller offer with the full quantity.`);
  }

  if (countryWarnings.length) {
    costNotes.push(`${countryWarnings.length} selected seller(s) still need country/shipping review.`);
  }

  if (unresolvedShippingCosts.length) {
    costNotes.push(`${unresolvedShippingCosts.length} selected seller(s) have no valid dynamic shipping row. Review country and shipping data.`);
  }

  if (optimization.iterations >= MAX_OPTIMIZATION_ITERATIONS) {
    costNotes.push("Optimization stopped at the 50-iteration safety limit.");
  }

  costNotes.push("Trustee fees and final checkout total are estimated. Verify at Cardmarket before purchasing.");
  const statusLabel = insufficientGroups.length
    ? "Action required"
    : unresolvedShippingCosts.length || countryWarnings.length
      ? "Needs review"
      : "Best plan ready";

  return {
    statusLabel,
    currentTotal,
    selectedTotal: score.total,
    cardTotal: score.cardTotal,
    fixedTotal: score.fixedTotal,
    trusteeTotal: score.trusteeTotal,
    shippingTotal: score.shippingTotal,
    sellerCosts: score.sellerCosts,
    savings,
    usedSellers,
    droppedSellers,
    selectedOffers,
    warnings,
    costNotes,
    countryWarnings,
    unresolvedSellers,
    iterations: optimization.iterations,
    insufficientGroups
  };
}

function buildInitialAssignment(groups, sellers, shippingRecords) {
  // Every assignment array below must stay index-aligned with `groups` (one slot per
  // group, `undefined` for excluded groups) — optimizeBySellerMoves looks up
  // groups[groupIndex] by that same index, so compacting away empty slots here would
  // desync the two arrays and cause it to move/overwrite the wrong card's offer.
  const cheapestByCard = groups.map((group) => group.candidates[0]);
  const currentCartAssignment = groups.map((group) => group.candidates.find((offer) => offer.sellerIndex === group.offers[0]?.sellerIndex) || group.candidates[0]);
  const consolidatedAssignments = sellers
    .map((_, sellerIndex) => groups.map((group) => group.candidates.find((offer) => offer.sellerIndex === sellerIndex)))
    .filter((assignment) => assignment.length && assignment.every((offer, i) => offer || groups[i].candidates.length === 0));
  const candidates = [cheapestByCard, currentCartAssignment, ...consolidatedAssignments].filter((assignment) => assignment.length);

  return candidates.reduce((bestAssignment, assignment) => {
    const candidateScore = scoreSelection(assignment, sellers, shippingRecords);
    const bestScore = scoreSelection(bestAssignment, sellers, shippingRecords);
    return isBetterScore(candidateScore, bestScore) ? assignment : bestAssignment;
  }, candidates[0] || []);
}

function optimizeBySellerMoves(initialSelection, groups, sellers, shippingRecords) {
  let selection = [...initialSelection];
  let score = scoreSelection(selection, sellers, shippingRecords);
  let iterations = 0;
  const sellerIndexes = sellers.map((_, sellerIndex) => sellerIndex);

  while (iterations < MAX_OPTIMIZATION_ITERATIONS) {
    let improved = false;
    iterations += 1;

    outerLoop:
    for (const fromSellerIndex of sellerIndexes) {
      for (const toSellerIndex of sellerIndexes) {
        if (fromSellerIndex === toSellerIndex) {
          continue;
        }

        for (let groupIndex = 0; groupIndex < selection.length; groupIndex += 1) {
          const currentOffer = selection[groupIndex];
          if (!currentOffer || currentOffer.sellerIndex !== fromSellerIndex) {
            continue;
          }

          const nextOffer = groups[groupIndex]?.candidates.find((candidate) => candidate.sellerIndex === toSellerIndex);
          if (!nextOffer) {
            continue;
          }

          const trialSelection = [...selection];
          trialSelection[groupIndex] = nextOffer;
          const trialScore = scoreSelection(trialSelection, sellers, shippingRecords);
          const delta = trialScore.total - score.total;

          if (delta < -0.005) {
            selection = trialSelection;
            score = trialScore;
            improved = true;
            break outerLoop;
          }
        }
      }
    }

    if (!improved) {
      break;
    }
  }

  return { selectedOffers: selection.filter(Boolean), score, iterations };
}

function scoreSelection(selection, sellers, shippingRecords) {
  const validSelection = selection.filter(Boolean);
  const sellerCosts = estimateSelectedSellerCosts(validSelection, sellers, shippingRecords);
  const cardTotal = validSelection.reduce((sum, offer) => sum + Number(offer.requiredQuantity || offer.quantity || 1) * Number(offer.unitPrice || 0), 0);
  const fixedTotal = sellerCosts.reduce((sum, cost) => sum + cost.totalCost, 0);
  const shippingTotal = sellerCosts.reduce((sum, cost) => sum + (Number.isFinite(cost.shippingValue) ? cost.shippingValue : 0), 0);
  const trusteeTotal = sellerCosts.reduce((sum, cost) => sum + (Number.isFinite(cost.trusteeFeeValue) ? cost.trusteeFeeValue : 0), 0);

  return {
    total: cardTotal + fixedTotal,
    cardTotal,
    fixedTotal,
    shippingTotal,
    trusteeTotal,
    sellerCount: sellerCosts.length,
    sellerCosts
  };
}

function isBetterScore(candidate, current) {
  if (candidate.total < current.total - 0.005) {
    return true;
  }
  if (Math.abs(candidate.total - current.total) < 0.005 && candidate.sellerCount < current.sellerCount) {
    return true;
  }
  return false;
}

function sellerFixedCost(seller) {
  const explicitFixed = Number(seller.shippingValue || 0) + Number(seller.trusteeValue || 0);
  if (explicitFixed > 0) {
    return explicitFixed;
  }

  const total = Number(seller.total);
  const article = Number(seller.articleValue);
  if (Number.isFinite(total) && Number.isFinite(article) && total >= article) {
    return total - article;
  }

  return 0;
}

function estimateSelectedSellerCosts(selection, sellers, shippingRecords) {
  const grouped = groupSelectedOffersBySeller(selection);
  return [...grouped.entries()].map(([sellerIndex, offers]) => estimateSellerCost(sellers[sellerIndex], sellerIndex, offers, shippingRecords));
}

function estimateSellerCost(seller, sellerIndex, offers, shippingRecords) {
  const articleValue = roundMoney(offerSubtotal(offers));
  const quantity = offers.reduce((sum, offer) => sum + Number(offer.requiredQuantity || offer.quantity || 1), 0);

  const hasOverride = seller.shippingCostOverride !== null && seller.shippingCostOverride !== undefined && Number.isFinite(seller.shippingCostOverride);
  const shippingResult = hasOverride
    ? applyShippingOverride(seller, offers)
    : calculateShippingCost({
        shippingRecords,
        country: seller.sellerCountry,
        cardCount: quantity,
        orderValue: articleValue
      });

  const trusteeMethod = shippingResult.ok ? shippingResult.method : seller.shippingMethod;
  const trusteeTracked = shippingResult.ok ? shippingResult.tracked : seller.trackingStatus === "tracked";
  const trusteeResult = calculateTrusteeFee({
    articleValue,
    shippingMethod: trusteeMethod,
    tracked: trusteeTracked,
    isRegistered: shippingResult.ok ? shippingResult.isRegistered : false,
    sellerLifetimeSales: seller.sellerLifetimeSales ?? seller.completedSales ?? null
  });
  const exactParsedTrustee = exactParsedTrusteeValue(seller, articleValue, quantity, trusteeMethod, trusteeTracked);
  const trusteeFeeValue = roundMoney(exactParsedTrustee ?? trusteeResult.fee);
  const trusteeSource = exactParsedTrustee !== null ? "parsed_exact" : "estimated_rule";
  const trusteeSourceLabel = exactParsedTrustee !== null ? "Exact from parsed cart" : "Estimated from trustee rule";

  if (!shippingResult.ok) {
    return {
      sellerIndex,
      source: "unresolved",
      sourceLabel: "No valid dynamic shipping row",
      articleValue,
      quantity,
      estimatedWeight: shippingResult.estimatedWeight,
      shippingMethod: seller.shippingMethod || "Unknown shipping",
      trackingStatus: shippingResult.tracked ? "tracked" : "untracked",
      isRegistered: shippingResult.isRegistered || false,
      cardmarketFeeValue: 0,
      trusteeFeeValue,
      trusteeRate: trusteeResult.rate,
      trusteeMethodCategory: trusteeResult.methodCategory,
      trusteeSource,
      trusteeSourceLabel,
      shippingValue: Number.POSITIVE_INFINITY,
      totalCost: Number.POSITIVE_INFINITY,
      shippingDebug: shippingResult,
      trusteeDebug: trusteeResult
    };
  }

  const shippingValue = roundMoney(shippingResult.cost);

  return {
    sellerIndex,
    source: hasOverride ? "manual_override" : "recalculated",
    sourceLabel: hasOverride ? "Manual shipping cost override" : "Dynamic shipping from table",
    articleValue,
    quantity,
    estimatedWeight: shippingResult.estimatedWeight,
    shippingMethod: shippingResult.method,
    trackingStatus: shippingResult.tracked ? "tracked" : "untracked",
    isRegistered: shippingResult.isRegistered || false,
    cardmarketFeeValue: shippingResult.cardmarketFeeValue,
    trusteeFeeValue,
    trusteeRate: trusteeResult.rate,
    trusteeMethodCategory: trusteeResult.methodCategory,
    trusteeSource,
    trusteeSourceLabel,
    shippingValue,
    totalCost: roundMoney(shippingValue + trusteeFeeValue),
    shippingDebug: shippingResult,
    trusteeDebug: trusteeResult
  };
}

function offerSubtotal(offers) {
  return offers.reduce((sum, offer) => sum + Number(offer.requiredQuantity || offer.quantity || 1) * Number(offer.unitPrice || 0), 0);
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function estimateCurrentTotal(sellers) {
  const sellerTotals = sellers.map((seller) => Number(seller.total)).filter(Number.isFinite);
  if (sellerTotals.length) {
    return sellerTotals.reduce((sum, total) => sum + total, 0);
  }

  return sellers.reduce((sum, seller) => {
    const cardTotal = seller.items.reduce((itemSum, item) => itemSum + Number(item.quantity || 1) * Number(item.price || 0), 0);
    return sum + cardTotal + sellerFixedCost(seller);
  }, 0);
}

function optimizationSummaryTemplate(result) {
  const cardValue = result.cardTotal;
  const shippingTotal = result.shippingTotal;
  const trusteeTotal = result.trusteeTotal;
  const feeTotal = result.sellerCosts.reduce((sum, sellerCost) => sum + Number(sellerCost.cardmarketFeeValue || 0), 0);
  const selectedCardGroups = result.selectedOffers.length;
  const totalCopies = result.selectedOffers.reduce((sum, offer) => sum + Number(offer.requiredQuantity || offer.quantity || 1), 0);
  const hasEstimatedTrustee = result.sellerCosts.some((sellerCost) => sellerCost.trusteeSource !== "parsed_exact");
  const trusteeLabel = hasEstimatedTrustee ? "Fees / trustee" : "Fees / trustee";
  const trusteeNote = hasEstimatedTrustee ? "Estimated · verify at Cardmarket checkout" : "Verify at Cardmarket checkout";
  return `
    <div class="summary-hero-card summary-hero-forge">
      <div class="summary-hero-main">
        <div class="summary-hero-copy">
          <span class="eyebrow">STEP 3 — OPTIMIZE</span>
          <h3>${escapeHtml(formatEstimatedMoney(result.selectedTotal))}</h3>
          <p>Buy the cards below from the selected sellers. Verify final totals at Cardmarket checkout.</p>
        </div>
        <div class="plan-pill-row" aria-label="Buying plan summary">
          <span class="plan-pill">${escapeHtml(`Sellers to use: ${result.usedSellers.length}`)}</span>
          <span class="plan-pill">${escapeHtml(`Different cards: ${selectedCardGroups}`)}</span>
          <span class="plan-pill">${escapeHtml(`Total copies: ${totalCopies}`)}</span>
        </div>
      </div>
      <div class="summary-breakdown-card">
        <div class="summary-breakdown-row">
          <span>Cards / article value</span>
          <strong>${escapeHtml(formatMoney(cardValue))}</strong>
        </div>
        <div class="summary-breakdown-row">
          <span>Shipping</span>
          <strong>${escapeHtml(formatEstimatedMoney(shippingTotal))}</strong>
        </div>
        <div class="summary-breakdown-row summary-breakdown-row-note">
          <span>${escapeHtml(trusteeLabel)}</span>
          <strong>${escapeHtml(`Estimated ${formatEstimatedMoney(trusteeTotal)}`)}</strong>
          <small>${escapeHtml(trusteeNote)}</small>
        </div>
        ${SHIPPING_DATA_INCLUDES_CARDMARKET_FEE ? "" : `
          <div class="summary-breakdown-row">
            <span>Cardmarket fees</span>
            <strong>${escapeHtml(formatEstimatedMoney(feeTotal))}</strong>
          </div>
        `}
      </div>
      <div class="button-row" style="grid-column:1/-1;margin-top:8px;">
        <button id="confirmPlanButton" class="primary-button" type="button">Send to Cardmarket</button>
        <p id="confirmPlanStatus" style="margin:6px 0 0;font-size:12px;color:var(--text-muted);min-height:1em;"></p>
      </div>
    </div>
  `;
}

function resultSummaryTemplate(result) {
  const totalItems = result.selectedOffers.reduce((sum, offer) => sum + Number(offer.requiredQuantity || offer.quantity || 1), 0);

  return `
    <div class="result-summary-strip">
      <div class="summary-metric summary-metric--total">
        <div class="summary-metric-label">Total cost</div>
        <div class="summary-metric-value">${escapeHtml(formatEstimatedMoney(result.selectedTotal))}</div>
      </div>
      <div class="summary-metric">
        <div class="summary-metric-label">Cards</div>
        <div class="summary-metric-value">${escapeHtml(String(totalItems))}</div>
      </div>
      <div class="summary-metric">
        <div class="summary-metric-label">Sellers</div>
        <div class="summary-metric-value">${escapeHtml(String(result.usedSellers.length))}</div>
      </div>
      <div class="summary-metric">
        <div class="summary-metric-label">Shipping</div>
        <div class="summary-metric-value">${escapeHtml(formatEstimatedMoney(result.shippingTotal))}</div>
      </div>
    </div>
  `;
}

function recommendationsTemplate(result) {
  const planBySeller = groupSelectedOffersBySeller(result.selectedOffers);
  const costBySeller = new Map(result.sellerCosts.map((cost) => [cost.sellerIndex, cost]));
  const enrichedSelectedOffers = result.selectedOffers.map((offer) => enrichOfferWithReference(offer));
  const highPriceNote = hasHighPricedCards(enrichedSelectedOffers) ? generateHighPriceNote(enrichedSelectedOffers) : "";
  const unresolvedSellers = result.usedSellers.filter(({ sellerIndex }) => costBySeller.get(sellerIndex)?.source === "unresolved");
  const resolvedSellers = result.usedSellers.filter(({ sellerIndex }) => costBySeller.get(sellerIndex)?.source !== "unresolved");

  const renderSeller = ({ seller, sellerIndex }, displayIndex) =>
    sellerPlanTemplate(seller, sellerIndex, displayIndex + 1, planBySeller.get(sellerIndex) || [], costBySeller.get(sellerIndex));

  const unresolvedGroup = unresolvedSellers.length ? `
    <div class="seller-group seller-group--unresolved">
      <h3 class="seller-group-heading">Needs attention before buying</h3>
      ${unresolvedSellers.map(renderSeller).join("")}
    </div>
  ` : "";

  const resolvedGroup = resolvedSellers.length ? `
    <div class="seller-group seller-group--resolved">
      ${resolvedSellers.map(renderSeller).join("")}
    </div>
  ` : "";

  return `
    ${droppedSellersTemplate(result)}
    ${resultSummaryTemplate(result)}
    ${highPriceNote}
    ${unresolvedSellersTemplate(result, planBySeller, costBySeller)}
    <h2 class="recommendation-grid-heading">Recommended sellers</h2>
    <div class="recommendation-grid">
      ${unresolvedGroup}
      ${resolvedGroup}
    </div>
  `;
}

function unresolvedSellersTemplate(result, planBySeller, costBySeller) {
  if (!planBySeller) {
    planBySeller = groupSelectedOffersBySeller(result.selectedOffers);
  }
  if (!costBySeller) {
    costBySeller = new Map(result.sellerCosts.map(c => [c.sellerIndex, c]));
  }
  const unresolvedEntries = result.usedSellers.filter(({ sellerIndex }) =>
    costBySeller.get(sellerIndex)?.source === "unresolved"
  );

  if (!unresolvedEntries.length) {
    return "";
  }

  const count = unresolvedEntries.length;

  return `
    <section class="panel unresolved-sellers-panel" aria-label="Sellers needing shipping resolution">
      <div class="panel-heading">
        <h2>Action required — shipping costs unresolved</h2>
        <span class="status-pill warning">${escapeHtml(`${count} seller${count === 1 ? "" : "s"}`)}</span>
      </div>
      <p class="panel-description">Fill in the form for each seller below, then apply to recalculate.</p>
      ${unresolvedEntries.map(({ seller, sellerIndex }) => {
        const sellerCost = costBySeller.get(sellerIndex);
        const offers = planBySeller.get(sellerIndex) || [];
        const cardCount = offers.reduce((sum, o) => sum + Number(o.requiredQuantity || o.quantity || 1), 0);
        const articleValue = sellerCost?.articleValue ?? offerSubtotal(offers);
        const reason = sellerCost?.shippingDebug?.reason || "Shipping cost could not be determined";
        return `
          <div class="unresolved-seller-row" id="resolve-seller-${escapeAttribute(String(sellerIndex))}">
            <div class="unresolved-seller-info">
              <strong class="unresolved-seller-name">${escapeHtml(seller.sellerName)}</strong>
              <span class="unresolved-seller-meta">${escapeHtml(`${cardCount} card${cardCount === 1 ? "" : "s"} · ${formatMoney(articleValue)}`)}</span>
              <span class="unresolved-reason note-text">${escapeHtml(reason)}</span>
            </div>
            <form class="unresolved-fix-form" data-seller-index="${escapeAttribute(String(sellerIndex))}">
              <label class="field">
                <span>Country</span>
                <select class="unresolved-country-select" name="sellerCountry">
                  <option value="">-- Select country --</option>
                  ${COUNTRY_OPTIONS.map(country => `<option value="${escapeAttribute(country)}" ${seller.sellerCountry === country ? "selected" : ""}>${escapeHtml(country)}</option>`).join("")}
                </select>
              </label>
              <label class="field">
                <span>Shipping cost override (EUR, optional)</span>
                <input type="number" class="unresolved-cost-input" name="shippingCostOverride" step="0.01" min="0" placeholder="Leave blank to auto-calculate" value="${seller.shippingCostOverride !== null && seller.shippingCostOverride !== undefined ? escapeAttribute(String(seller.shippingCostOverride)) : ""}">
              </label>
              <button type="button" class="primary-button unresolved-apply-btn" data-action="apply-unresolved" data-seller-index="${escapeAttribute(String(sellerIndex))}">Apply &amp; Recalculate</button>
            </form>
            <a class="fix-below-link" href="#resolve-seller-${escapeAttribute(String(sellerIndex))}">Fix below ↓</a>
          </div>
        `;
      }).join("")}
    </section>
  `;
}

function warningBannerTemplate(result, warningEntries) {
  const criticalCount = warningEntries.filter((entry) => entry.severity === "critical").length;
  const warningCount = warningEntries.filter((entry) => entry.severity === "warning").length;
  const highestSeverity = criticalCount ? "critical" : warningCount ? "warning" : "info";

  const sectionTitle = criticalCount ? "⚠️ Must fix before buying" : warningCount ? "ℹ️ Verify at checkout" : "ℹ️ Quick note";
  const sectionBody = criticalCount
    ? "These issues must be fixed before you buy. Review them below."
    : warningCount
      ? "These are estimates. Double-check them on Cardmarket before confirming."
      : "Final costs will be verified when you checkout on Cardmarket.";
  const quickActions = warningEntries.slice(0, 3).map((entry) => entry.whatToDo);

  return `
    <div class="result-warning severity-${escapeAttribute(highestSeverity)}">
      <div class="result-warning-header">
        <div class="result-warning-title-row">
          <h3 class="result-warning-title">${escapeHtml(sectionTitle)}</h3>
        </div>
        <p class="result-warning-body">${escapeHtml(sectionBody)}</p>
      </div>
      <div class="warning-quick-actions">
        ${quickActions.map((action) => `<p>${escapeHtml(action)}</p>`).join("")}
      </div>
      <details class="warning-details" ${criticalCount ? "open" : ""}>
        <summary>Show all warning details</summary>
        <div class="warning-list">
          ${warningEntries.map((entry) => warningEntryTemplate(entry)).join("")}
        </div>
      </details>
    </div>
  `;
}

function warningEntryTemplate(entry) {
  const pillClass = entry.severity === "critical" ? "warning" : entry.severity === "warning" ? "warning" : "info";
  return `
    <article class="warning-item severity-${escapeAttribute(entry.severity)}">
      <div class="warning-item-header">
        <strong>${escapeHtml(entry.title)}</strong>
        <span class="status-pill ${pillClass}">${escapeHtml(entry.severity)}</span>
      </div>
      <p class="warning-detail"><strong>What happened:</strong> ${escapeHtml(entry.whatHappened || "See warning details.")}</p>
      <p class="warning-detail"><strong>Why it matters:</strong> ${escapeHtml(entry.whyItMatters || "It may affect total cost or data accuracy.")}</p>
      <p class="warning-action"><strong>What to do:</strong> ${escapeHtml(entry.whatToDo || "Review and correct this entry.")}</p>
      ${entry.affected ? `<p class="warning-detail"><strong>Affects:</strong> ${escapeHtml(entry.affected)}</p>` : ""}
    </article>
  `;
}

function buildResultWarnings(result) {
  const entries = [];

  if (result.insufficientGroups?.length) {
    entries.push({
      severity: "critical",
      title: "Desired quantities are not fully available",
      affected: result.insufficientGroups.map((group) => group.cardName).join(", "),
      whatHappened: "At least one card does not have enough available copies for your requested quantity.",
      whyItMatters: "Your current buying plan cannot fulfill the full cart as requested.",
      whatToDo: "Lower requested quantities or add more offers, then optimize again."
    });
  }

  const unresolvedCosts = (result.sellerCosts || []).filter(c => c.source === "unresolved");
  if (unresolvedCosts.length) {
    const affectedNames = unresolvedCosts.map(c => {
      const entry = result.usedSellers?.find(({ sellerIndex }) => sellerIndex === c.sellerIndex);
      return entry?.seller?.sellerName || `Seller ${c.sellerIndex + 1}`;
    }).join(", ");
    entries.push({
      severity: "critical",
      title: "Shipping costs unresolved — action required",
      affected: affectedNames,
      whatHappened: "Shipping costs could not be calculated for these sellers.",
      whyItMatters: "The buying plan total is incomplete until shipping is resolved.",
      whatToDo: "Use the fix form in the sellers section to set country or override shipping cost."
    });
  }

  const hasEstimatedTrustee = result.sellerCosts?.some((sellerCost) => sellerCost.trusteeSource !== "parsed_exact");
  if (!entries.length && hasEstimatedTrustee) {
    entries.push({
      severity: "info",
      title: "Trustee and fee values are estimated",
      affected: "",
      whatHappened: "At least one seller uses a rule-based trustee estimate.",
      whyItMatters: "Final checkout fees may differ slightly on Cardmarket.",
      whatToDo: "Verify final fees during checkout before placing orders."
    });
  }

  return entries;
}

function sellerNameForCost(result, sellerCost) {
  return result.usedSellers.find((entry) => entry.sellerIndex === sellerCost.sellerIndex)?.seller?.sellerName || `Seller ${sellerCost.sellerIndex + 1}`;
}

function assignmentTableTemplate(result) {
  if (!result.selectedOffers.length) {
    return assignmentEmptyState();
  }

  return `
    <div class="assignment-table-wrap">
      <table class="assignment-table">
        <thead>
          <tr>
            <th>Card</th>
            <th>Qty</th>
            <th>Condition</th>
            <th>Selected seller</th>
            <th>Price</th>
            <th>Notes / reason</th>
          </tr>
        </thead>
        <tbody>
          ${result.selectedOffers.map((offer) => assignmentRowTemplate(offer, result)).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function assignmentRowTemplate(offer, result) {
  const alternativeCount = result.selectedOffers.filter((candidate) => normalizeOfferKey(candidate.cardName) === normalizeOfferKey(offer.cardName)).length;
  const note = alternativeCount > 1
    ? "Selected for lowest combined seller cost."
    : "Selected seller is the active recommendation.";

  return `
    <tr>
      <td>${escapeHtml(offer.cardName)}</td>
      <td>${escapeHtml(offer.requiredQuantity || offer.quantity)}</td>
      <td>${escapeHtml(offer.condition || "Unknown")}</td>
      <td>${escapeHtml(offer.sellerName)}</td>
      <td>${escapeHtml(formatMoney(offer.unitPrice))}</td>
      <td>${escapeHtml(note)}</td>
    </tr>
  `;
}

function assumptionsTemplate(result) {
  return `
    <div class="assumptions-list">
      ${result.sellerCosts.map((sellerCost) => assumptionsCardTemplate(result, sellerCost)).join("")}
    </div>
  `;
}

function assumptionsCardTemplate(result, sellerCost) {
  const seller = result.usedSellers.find((entry) => entry.sellerIndex === sellerCost.sellerIndex)?.seller;
  const shippingDebug = sellerCost.shippingDebug;
  const trusteeDebug = sellerCost.trusteeDebug;

  return `
    <article class="assumption-card">
      <div class="assumption-card-header">
        <strong>${escapeHtml(seller?.sellerName || `Seller ${sellerCost.sellerIndex + 1}`)}</strong>
        <span class="status-pill ${sellerCost.source === "unresolved" ? "warning" : "good"}">${escapeHtml(sellerCost.source === "unresolved" ? "Estimated / review" : "Exact from table")}</span>
      </div>
      <p>${escapeHtml(shippingDebug?.reason || "Shipping method selected from the available country rows.")}</p>
      <ul class="assumption-points">
        <li>Weight estimate: ${escapeHtml(`${sellerCost.estimatedWeight}g`)}</li>
        <li>Tracking: ${escapeHtml(sellerCost.trackingStatus)}</li>
        <li>Method: ${escapeHtml(sellerCost.shippingMethod || "Unknown")}</li>
        <li>Trustee: ${escapeHtml(trusteeDebug?.applies ? `${formatMoney(sellerCost.trusteeFeeValue)} at ${(trusteeDebug.rate * 100).toFixed(2)}%` : "Not applied")}</li>
        <li>Trustee source: ${escapeHtml(sellerCost.trusteeSourceLabel || "Estimated from trustee rule")}</li>
        <li>Trustee trigger: ${escapeHtml(trusteeDebug?.reason || "Not evaluated")}</li>
        <li>Cardmarket fee handling: ${escapeHtml(SHIPPING_DATA_INCLUDES_CARDMARKET_FEE ? "Included in shipping data" : "Added separately")}</li>
      </ul>
    </article>
  `;
}

function emptyStateBlockTemplate({ icon, title, body }) {
  return `
    <div class="empty-state-card">
      <div class="empty-state-icon" aria-hidden="true">${icon}</div>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(body)}</p>
    </div>
  `;
}

function summaryEmptyState() {
  return emptyStateBlockTemplate({
    icon: ICON_CHART,
    title: "No buying plan yet",
    body: "Paste your Cardmarket cart and build a buying plan to see the cleanest seller split."
  });
}

function recommendationsEmptyState() {
  return emptyStateBlockTemplate({
    icon: ICON_CART,
    title: "No buying plan yet",
    body: "Buy-from-these-sellers instructions will appear here after optimization."
  });
}

function assignmentEmptyState() {
  return emptyStateBlockTemplate({
    icon: ICON_LIST,
    title: "No assignments yet",
    body: "The chosen seller for each card will be listed here after optimization."
  });
}

function assumptionsEmptyState() {
  return emptyStateBlockTemplate({
    icon: ICON_INFO,
    title: "No advanced details yet",
    body: "Validation, shipping traces, and calculation notes will appear here after optimization."
  });
}


function droppedSellersTemplate(result) {
  if (!result.droppedSellers || !result.droppedSellers.length) {
    return "";
  }

  return `
    <section class="panel notes-panel dropped-sellers-section">
      <div class="panel-heading panel-heading-soft">
        <div>
          <p class="eyebrow">Remove from cart</p>
          <h2>Sellers not in plan</h2>
          <p class="panel-description panel-description-tight">Remove items from these sellers in your Cardmarket cart first.</p>
        </div>
      </div>
      <div class="dropped-sellers-list">
        ${result.droppedSellers.map(({ seller, sellerIndex }) => `
          <div class="dropped-seller-item">
            <strong>${escapeHtml(seller.sellerName)}</strong>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function advancedDetailsTemplate(result, offerGroups) {
  const hasDroppedSellers = result.droppedSellers && result.droppedSellers.length > 0;
  const sections = [];

  sections.push(`
    <div class="advanced-section">
      <h3>Offer matrix</h3>
      <p class="section-description">All available offers grouped by card:</p>
      ${offerMatrixTemplate(offerGroups)}
    </div>
  `);

  sections.push(`
    <div class="advanced-section">
      <h3>Your assignments</h3>
      <p class="section-description">Which seller was chosen for each card:</p>
      ${assignmentTableTemplate(result)}
    </div>
  `);

  sections.push(`
    <div class="advanced-section">
      <h3>Calculation details</h3>
      <p class="section-description">Shipping, trustee, and cost assumptions:</p>
      ${assumptionsTemplate(result)}
    </div>
  `);

  return sections.join("");
}

function countryReviewTemplate(countryWarnings) {
  return `
    <div class="country-review-list">
      ${countryWarnings.map(({ seller, sellerIndex }) => countryReviewRowTemplate(seller, sellerIndex)).join("")}
    </div>
  `;
}

function countryReviewRowTemplate(seller, sellerIndex) {
  const reason = seller.countryInference?.ambiguous ? "Ambiguous match" : "No confident match";

  return `
    <div class="country-review-row" data-seller-index="${sellerIndex}">
      <div>
        <strong>${escapeHtml(seller.sellerName)}</strong>
        <span>${escapeHtml(reason)}</span>
      </div>
      <label>
        <span>Country</span>
        ${selectFieldTemplate("", "sellerCountry", seller.sellerCountry || "Unknown", countryOptions())}
      </label>
      <label>
        <span>Shipping method</span>
        <input data-field="shippingMethod" value="${escapeAttribute(seller.shippingMethod || "")}" aria-label="Shipping method for ${escapeAttribute(seller.sellerName)}">
      </label>
      <label>
        <span>Tracked</span>
        ${selectFieldTemplate("", "trackingStatus", seller.trackingStatus || "unknown", ["unknown", "tracked", "untracked"])}
      </label>
    </div>
  `;
}

// Flag emojis come from a hardcoded internal map and are safe to render without escapeHtml.
function countryFlag(countryName) {
  const FLAGS = {
    "germany": "🇩🇪", "italy": "🇮🇹", "france": "🇫🇷", "spain": "🇪🇸",
    "poland": "🇵🇱", "netherlands": "🇳🇱", "united kingdom": "🇬🇧",
    "austria": "🇦🇹", "belgium": "🇧🇪", "portugal": "🇵🇹",
    "czech republic": "🇨🇿", "slovakia": "🇸🇰", "hungary": "🇭🇺",
    "romania": "🇷🇴", "bulgaria": "🇧🇬", "greece": "🇬🇷",
    "croatia": "🇭🇷", "sweden": "🇸🇪", "finland": "🇫🇮",
    "denmark": "🇩🇰", "norway": "🇳🇴"
  };
  return FLAGS[String(countryName || "").toLowerCase().trim()] ?? "";
}

function sellerPlanTemplate(seller, sellerIndex, displayNumber, offers, sellerCost) {
  const cardTotal = sellerCost?.articleValue ?? offerSubtotal(offers);
  const shippingTotal = sellerCost?.shippingValue ?? 0;
  const feeTotal = sellerCost?.cardmarketFeeValue ?? 0;
  const trusteeTotal = sellerCost?.trusteeFeeValue ?? 0;
  const fixedTotal = sellerCost?.totalCost ?? (shippingTotal + feeTotal + trusteeTotal);
  const displayTotal = Number.isFinite(fixedTotal) ? roundMoney(cardTotal + fixedTotal) : Number.POSITIVE_INFINITY;
  const shippingMethod = sellerCost?.shippingMethod || seller.shippingMethod || "Unknown shipping";
  const trackingLabel = sellerCost?.trackingStatus || seller.trackingStatus || "unknown";
  const itemCount = offers.reduce((sum, offer) => sum + Number(offer.requiredQuantity || offer.quantity || 1), 0);
  const estimatedWeight = sellerCost?.estimatedWeight ?? estimateShipmentWeight(offers.length);

  // Compute excluded cards (available from this seller but not selected)
  const selectedCardNames = new Set(offers.map(offer => normalizeOfferKey(offer.cardName)));
  const excludedCards = (seller.items || []).filter(item => {
    const normalizedName = normalizeOfferKey(item.cardName);
    return normalizedName && !selectedCardNames.has(normalizedName);
  });

  const excludedCardsSection = excludedCards.length ? `
    <details class="seller-excluded-section">
      <summary class="seller-excluded-button">
        <span class="seller-excluded-icon">▼</span>
        <span>${escapeHtml(excludedCards.length)} card(s) cheaper elsewhere</span>
      </summary>
      <div class="seller-excluded-list">
        ${excludedCards.map(item => `
          <div class="seller-excluded-item">
            <div class="excluded-card-details">
              <span class="excluded-card-name">${escapeHtml(item.cardName)}</span>
              <span class="excluded-card-qty">${escapeHtml(item.quantity || 1)}×</span>
              <span class="excluded-card-price">${escapeHtml(formatMoney(item.price || 0))}</span>
            </div>
            <span class="excluded-reason">Cheaper elsewhere</span>
          </div>
        `).join("")}
      </div>
    </details>
  ` : "";

  const isUnresolved = sellerCost?.source === "unresolved";

  const heroSubtitle = isUnresolved ? "" :
    displayNumber === 1 ? "Lowest cost option" :
    itemCount >= 10 ? "Completes your order" :
    "Fills gaps";

  return `
    <article class="recommendation-card premium-seller-card${isUnresolved ? " seller-card--unresolved" : " seller-resolved"}${displayNumber === 1 && !isUnresolved ? " seller-recommended" : ""}">
      <header class="seller-card-header">
        <div class="seller-number-badge">${escapeHtml(displayNumber)}</div>
        <div class="seller-info-primary">
          <h3>${escapeHtml(seller.sellerName)}</h3>
          <div class="seller-meta">
            ${escapeHtml(seller.sellerCountry || "Unknown")} ${countryFlag(seller.sellerCountry)}
          </div>
        </div>
        ${isUnresolved
          ? `<a class="fix-shipping-link ghost-button" href="#resolve-seller-${escapeAttribute(String(sellerIndex))}">Fix shipping →</a>`
          : ""}
      </header>

      <div class="seller-total-hero">
        <span class="seller-total-hero-label">Total cost</span>
        <span class="seller-total-hero-amount">${escapeHtml(formatEstimatedMoney(displayTotal))}</span>
        ${heroSubtitle ? `<span class="seller-total-hero-sub">${escapeHtml(heroSubtitle)}</span>` : ""}
      </div>

      <div class="seller-data-grid">
        <div class="seller-data-item">
          <span class="seller-data-label">Cards</span>
          <span class="seller-data-value">${escapeHtml(String(itemCount))}</span>
        </div>
        <div class="seller-data-item">
          <span class="seller-data-label">Articles</span>
          <span class="seller-data-value">${escapeHtml(formatMoney(cardTotal))}</span>
        </div>
        <div class="seller-data-item">
          <span class="seller-data-label">Shipping</span>
          <span class="seller-data-value">${escapeHtml(formatMoney(shippingTotal))}</span>
        </div>
        <div class="seller-data-item">
          <span class="seller-data-label">Trustee fee</span>
          <span class="seller-data-value">${escapeHtml(formatMoney(trusteeTotal))}</span>
        </div>
      </div>

      <details class="seller-cards-toggle">
        <summary>View cards</summary>
        <div class="seller-cards-section">
          <table class="recommendation-table">
            <tbody>
              ${offers.map((offer) => recommendationOfferRowTemplate(offer)).join("")}
            </tbody>
          </table>
          ${excludedCardsSection}
        </div>
      </details>

      <details class="cost-breakdown">
        <summary class="seller-section-label">Cost Breakdown</summary>
        <div class="breakdown-item">
          <span>Cards</span>
          <strong>${escapeHtml(formatMoney(cardTotal))}</strong>
        </div>
        <div class="breakdown-item">
          <span>Shipping ${tooltipChip(`${shippingMethod} · ${trackingLabel} · ~${estimatedWeight}g`)}</span>
          <strong>${escapeHtml(formatMoney(shippingTotal))}</strong>
        </div>
        <div class="breakdown-item">
          <span>Trustee</span>
          <strong>${escapeHtml(formatMoney(trusteeTotal))}</strong>
        </div>
        ${SHIPPING_DATA_INCLUDES_CARDMARKET_FEE ? "" : `
          <div class="breakdown-item">
            <span>Fees</span>
            <strong>${escapeHtml(formatMoney(feeTotal))}</strong>
          </div>
        `}
        <div class="breakdown-divider"></div>
        <div class="breakdown-item breakdown-total">
          <span>Total</span>
          <strong>${escapeHtml(formatEstimatedMoney(displayTotal))}</strong>
        </div>
      </details>
    </article>
  `;
}

function recommendationOfferRowTemplate(offer) {
  const referenceOffer = enrichOfferWithReference(offer);
  const unitLabel = formatMoney(offer.unitPrice);
  const shouldShowReferenceDelta = referenceOffer.hasReference
    && referenceOffer.deltaDisplay
    && referenceOffer.deltaDisplay !== "—";
  const referenceDelta = shouldShowReferenceDelta
    ? `<span class="reference-delta-inline delta-${escapeAttribute(referenceOffer.deltaColor)}" data-card-name="${escapeAttribute(offer.cardName)}" data-price="${escapeAttribute(String(offer.unitPrice))}" title="${escapeAttribute(referenceDeltaTitle(referenceOffer, getReferenceData(offer.cardName)))}">${escapeHtml(referenceOffer.deltaDisplay)}</span>`
    : "";
  const referenceHint = referenceOffer.hasReference
    ? `<div class="reference-inline-note">Scryfall ref ${escapeHtml(formatReferenceMoney(referenceOffer.referencePrice, referenceOffer.referenceCurrency))}</div>`
    : state.scryallLookupInProgress
      ? `<div class="reference-inline-note">Scryfall loading...</div>`
      : "";

  return `
    <tr>
      <td>${escapeHtml(offer.requiredQuantity || offer.quantity)}×</td>
      <td>
        ${escapeHtml(offer.cardName)}
        ${referenceHint}
      </td>
      <td class="condition-cell">${escapeHtml(offer.condition)}</td>
      <td class="price-cell">
        <span class="price-with-reference">${escapeHtml(unitLabel)}${referenceDelta}</span>
      </td>
    </tr>
  `;
}

function groupSelectedOffersBySeller(offers) {
  const grouped = new Map();
  offers.forEach((offer) => {
    if (!grouped.has(offer.sellerIndex)) {
      grouped.set(offer.sellerIndex, []);
    }
    grouped.get(offer.sellerIndex).push(offer);
  });
  return grouped;
}

function buildBuyingPlanText(result) {
  const groupedOffers = groupSelectedOffersBySeller(result.selectedOffers || []);
  const lines = [];

  (result.usedSellers || []).forEach(({ seller, sellerIndex }, index) => {
    const offers = groupedOffers.get(sellerIndex) || [];
    const sellerCost = (result.sellerCosts || []).find((cost) => cost.sellerIndex === sellerIndex) || {};
    const cardTotal = sellerCost.articleValue ?? offerSubtotal(offers);
    const shippingTotal = sellerCost.shippingValue ?? 0;
    const trusteeTotal = sellerCost.trusteeFeeValue ?? 0;
    const feeTotal = sellerCost.cardmarketFeeValue ?? 0;
    const fixedTotal = sellerCost.totalCost ?? (shippingTotal + trusteeTotal + feeTotal);
    const displayTotal = Number.isFinite(fixedTotal) ? roundMoney(cardTotal + fixedTotal) : Number.POSITIVE_INFINITY;

    lines.push(`Seller ${index + 1}: ${seller?.sellerName || `Seller ${sellerIndex + 1}`}`);
    offers.forEach((offer) => {
      const qty = offer.requiredQuantity || offer.quantity || 1;
      lines.push(`- ${qty}x ${offer.cardName} (${offer.condition}) @ ${formatMoney(offer.unitPrice)}`);
    });
    lines.push(`Cards: ${formatMoney(cardTotal)}`);
    lines.push(`Shipping: ${formatMoney(shippingTotal)}`);
    lines.push(`Trustee: ${formatMoney(trusteeTotal)}`);
    if (!SHIPPING_DATA_INCLUDES_CARDMARKET_FEE) {
      lines.push(`Fees: ${formatMoney(feeTotal)}`);
    }
    lines.push(`Total: ${formatEstimatedMoney(displayTotal)}`);
    lines.push("");
  });

  return lines.join("\n").trim();
}

function getReferenceData(cardName) {
  return state.priceReferences[normalizeReferenceKey(cardName)] || null;
}

function normalizeReferenceKey(cardName) {
  return getComparableDisplayName(cardName)
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function getComparableDisplayName(cardName) {
  return String(cardName || "")
    .replace(/\s+\([^)]+\)$/i, "")
    .trim()
    .replace(/\s+/g, " ");
}

function formatReferenceMoney(price, currency = "EUR") {
  if (!Number.isFinite(Number(price))) {
    return "Unavailable";
  }

  return currency === "EUR"
    ? formatMoney(price)
    : `${currency} ${Number(price).toFixed(2)}`;
}

function referenceSourceIcon(referenceData) {
  if (!referenceData || referenceData.error) {
    return "";
  }

  return "";
}

function referenceErrorLabel(reason) {
  switch (reason) {
    case "no_price_available":
      return "Scryfall found the card but returned no market price.";
    case "not_found":
      return "Scryfall could not find this card name.";
    case "timeout":
      return "Scryfall lookup timed out.";
    case "network_error":
      return "Scryfall lookup failed because the network request did not complete.";
    default:
      return "Scryfall reference price is unavailable.";
  }
}

function enrichOfferWithReference(offer) {
  return enrichCardWithReference(offer, getReferenceData(offer.cardName));
}

function referenceDeltaTitle(referenceCard, referenceData) {
  if (!referenceCard?.hasReference || !referenceData || referenceData.error) {
    return "Scryfall reference unavailable";
  }

  return `${formatMoney(referenceCard.price)} vs ${formatReferenceMoney(referenceData.price, referenceData.currency)} from ${referenceData.source}`;
}

function tooltipChip(text) {
  return `<span class="tooltip-chip" data-tooltip="${escapeAttribute(text)}" aria-label="${escapeAttribute(text)}" tabindex="0">?</span>`;
}

/**
 * Update reference price tooltips after Scryfall data loads
 *
 * This ensures that even if rows are re-rendered before Scryfall data arrives,
 * tooltips will be updated with correct reference prices when data becomes available.
 */
function updateReferenceTooltips() {
  // Find all reference delta badges (both in desired cards and recommendations)
  const badges = document.querySelectorAll(".reference-delta-badge");

  badges.forEach((badge) => {
    // Find the card name from nearby table row's data attribute or text content
    const row = badge.closest("tr");
    if (!row) return;

    const cardNameAttr = row.getAttribute("data-card-name");
    const cardNameFromBadge = badge.getAttribute("data-card-name");
    const cardNameFromText = row.querySelector("td")?.textContent?.trim();
    const cardName = cardNameAttr || cardNameFromBadge || cardNameFromText;

    if (!cardName) return;

    // Get the current reference data for this card
    const referenceData = getReferenceData(cardName);
    const priceFromBadge = Number(badge.getAttribute("data-price"));
    const priceFromCell = Number(row.querySelector(".price-cell")?.getAttribute("data-price"));
    const referenceCard = enrichCardWithReference(
      {
        cardName,
        price: Number.isFinite(priceFromBadge)
          ? priceFromBadge
          : Number.isFinite(priceFromCell)
            ? priceFromCell
            : 0
      },
      referenceData
    );

    // Update the tooltip title with the correct reference data
    const correctTitle = referenceDeltaTitle(referenceCard, referenceData);
    badge.setAttribute("title", correctTitle);
  });
}

function updateWorkflowStatus(label, tone = "muted", hint = "") {
  if (elements.optimizationState) {
    elements.optimizationState.textContent = label;
    elements.optimizationState.className = `status-pill ${tone}`;
  }
  if (elements.workflowHint) {
    elements.workflowHint.textContent = hint;
  }
}

function formatSavings(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) {
    return "Needs review";
  }
  if (Math.abs(amount) < 0.005) {
    return "EUR 0.00";
  }
  return amount > 0 ? formatMoney(amount) : `+${formatMoney(Math.abs(amount))}`;
}

function formatEstimatedMoney(value) {
  return Number.isFinite(Number(value)) ? formatMoney(value) : "Needs review";
}


function toReviewData() {
  const offerGroups = buildOfferGroups(state.parsed.sellers);
  return {
    rawText: state.parsed.rawText,
    optimizationModel: {
      requiredCards: offerGroups.map((group) => ({
        cardName: group.cardName,
        reviewQuantity: group.requiredQuantity,
        offers: group.offers
      })),
      sellerFixedCosts: state.parsed.sellers.map((seller) => ({
        sellerName: seller.sellerName,
        sellerCountry: seller.sellerCountry,
        shippingMethod: seller.shippingMethod,
        tracked: seller.trackingStatus,
        shippingValue: seller.shippingValue,
        trusteeValue: seller.trusteeValue
      }))
    },
    sellers: state.parsed.sellers.map((seller) => ({
      sellerName: seller.sellerName,
      shippingMethod: seller.shippingMethod,
      trackingStatus: seller.trackingStatus,
      sellerCountry: seller.sellerCountry,
      articleValue: seller.articleValue,
      shippingValue: seller.shippingValue,
      trusteeValue: seller.trusteeValue,
      total: seller.total,
      items: seller.items.map((item) => ({
        cardName: item.cardName,
        setName: item.setName || "",
        rarity: item.rarity || "",
        condition: item.condition,
        quantity: item.quantity,
        price: item.price,
        rawLine: item.rawLine
      })),
      rawText: seller.rawText
    }))
  };
}

function buildOfferGroups(sellers) {
  const groups = new Map();

  sellers.forEach((seller, sellerIndex) => {
    seller.items.forEach((item, itemIndex) => {
      const cardKey = normalizeOfferKey(item.cardName);
      const cardName = getComparableDisplayName(item.cardName);
      if (!cardKey) return;

      if (!groups.has(cardKey)) {
        groups.set(cardKey, {
          cardName,
          variantMaxQty: new Map(),
          lowestUnitPrice: Number.POSITIVE_INFINITY,
          highestUnitPrice: 0,
          offers: []
        });
      }

      const group = groups.get(cardKey);
      const quantity = Number(item.quantity || 1);
      const unitPrice = Number(item.price || 0);

      // If the parser embedded the set name inside the card name as "(Set Name)",
      // extract it so variant deduplication and the variant table both work correctly.
      const rawCardName = String(item.cardName || "");
      const embeddedSet = !item.setName ? (rawCardName.match(/\s+\(([^)]+)\)$/)?.[1] || "") : "";
      const effectiveSetName = item.setName || embeddedSet;

      // Track max qty per unique variant — same variant from competing sellers does not add up
      const vk = makeVariantKey({ ...item, setName: effectiveSetName });
      group.variantMaxQty.set(vk, Math.max(group.variantMaxQty.get(vk) || 0, quantity));

      group.lowestUnitPrice = Math.min(group.lowestUnitPrice, unitPrice);
      group.highestUnitPrice = Math.max(group.highestUnitPrice, unitPrice);
      group.offers.push({
        sellerName: seller.sellerName,
        sellerId: seller.sellerId || "",
        sellerProfileUrl: seller.sellerProfileUrl || "",
        shipmentId: seller.shipmentId || "",
        sellerIndex,
        itemIndex,
        itemId: item.id || "",
        articleId: item.articleId || "",
        productId: item.productId || "",
        productUrl: item.productUrl || "",
        cardName: item.cardName,
        comparableCardName: cardName,
        setName: effectiveSetName,
        expansionId: item.expansionId || "",
        collectorNumber: item.collectorNumber || "",
        rarity: item.rarity || "",
        rarityCode: item.rarityCode || "",
        condition: item.condition,
        conditionCode: item.conditionCode || "",
        language: item.language || "",
        languageCode: item.languageCode || "",
        comment: item.comment || "",
        quantity,
        unitPrice,
        sellerCountry: seller.sellerCountry,
        shippingMethod: seller.shippingMethod,
        tracked: seller.trackingStatus
      });
    });
  });

  return [...groups.values()]
    .map((group) => {
      const requiredQuantity = [...group.variantMaxQty.values()].reduce((a, b) => a + b, 0);
      return {
        cardName: group.cardName,
        requiredQuantity,
        variantCount: group.variantMaxQty.size,
        sellerCount: new Set(group.offers.map((o) => o.sellerName)).size,
        lowestUnitPrice: Number.isFinite(group.lowestUnitPrice) ? group.lowestUnitPrice : 0,
        highestUnitPrice: Number.isFinite(group.highestUnitPrice) ? group.highestUnitPrice : 0,
        offers: group.offers
      };
    })
    .sort((a, b) => a.cardName.localeCompare(b.cardName));
}

function makeVariantKey(item) {
  return [item.setName || "", item.collectorNumber || "", item.language || "", item.condition || ""].join("|");
}

function hasAnyPreference(cardName) {
  const prefs = state.variantPreferences[cardName] || {};
  return Object.values(prefs).some((p) => p !== "any");
}

function getTotalCopies(offerGroups) {
  return offerGroups.reduce((sum, group) => sum + group.requiredQuantity, 0);
}

function normalizeOfferKey(cardName, setName = "") {
  return getComparableDisplayName(cardName)
    .toLowerCase()
    .concat(setName ? ` ${String(setName).toLowerCase()}` : "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function exactParsedTrusteeValue(seller, articleValue, quantity, shippingMethod, tracked) {
  const parsedTrusteeValue = Number(seller.trusteeValue);
  if (!Number.isFinite(parsedTrusteeValue)) {
    return null;
  }

  const parsedArticleValue = Number(seller.articleValue);
  const parsedQuantity = seller.items.reduce((sum, item) => sum + Number(item.quantity || 1), 0);
  if (Math.abs(parsedArticleValue - articleValue) > 0.005 || parsedQuantity !== quantity) {
    return null;
  }

  const parsedMethod = normalizeMethodForComparison(seller.shippingMethod);
  const selectedMethod = normalizeMethodForComparison(shippingMethod);
  if (parsedMethod && selectedMethod && parsedMethod !== selectedMethod) {
    return null;
  }

  const parsedTracked = seller.trackingStatus || "unknown";
  const selectedTracked = tracked ? "tracked" : "untracked";
  if (parsedTracked !== "unknown" && parsedTracked !== selectedTracked) {
    return null;
  }

  return roundMoney(parsedTrusteeValue);
}

export const __testing = {
  state,
  advancedDetailsTemplate,
  buildOfferGroups,
  buildBuyingPlanText,
  buildResultWarnings,
  desiredCardsTableTemplate,
  getTotalCopies,
  groupSelectedOffersBySeller,
  normalizeReferenceKey,
  optimizeCart,
  optimizationSummaryTemplate,
  recommendationOfferRowTemplate,
  sellerPlanTemplate,
  warningBannerTemplate
};

function normalizeMethodForComparison(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\bmax weight\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function coerceSellerField(field, value) {
  if (["articleValue", "shippingValue", "trusteeValue", "total"].includes(field)) {
    return parseMoney(value) ?? 0;
  }
  return value;
}

function coerceItemField(field, value) {
  if (field === "quantity") {
    return Math.max(1, Number.parseInt(value, 10) || 1);
  }
  if (field === "price") {
    return parseMoney(value) ?? 0;
  }
  return value;
}

function moneyInputValue(value) {
  return value === null || value === undefined || Number.isNaN(Number(value)) ? "" : Number(value).toFixed(2);
}

function countryOptions() {
  return COUNTRY_OPTIONS;
}

function setMessage(message) {
  elements.parseMessage.textContent = message;
}
