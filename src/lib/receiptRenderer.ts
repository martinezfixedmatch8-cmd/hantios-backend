import type { ReceiptSnapshot } from "./receiptSnapshot";
import { isSupportedLanguage, type SupportedLanguage } from "./messageTemplates";

// Module 06 (Receipt System) -- deliberately NOT built on
// EmailTemplateRenderer (its subject/body/HTML-adjacent abstractions are
// email-specific, the wrong shape for narrow POS print or a WhatsApp text
// body). Borrows messageTemplates.ts's own registry SHAPE (same 5-language
// SupportedLanguage union, same "renderX(key, language, vars)" idea) with
// genuinely new content -- receipt static labels, not a single alert line.
//
// Deterministic by construction: (snapshot, snapshotVersion, RENDERER_VERSION)
// -> text, computed on demand, never stored -- satisfies both "PDF is NOT an
// implicit requirement" and the addendum's Rendering Determinism section.
// Bumping RENDERER_VERSION is how presentation can evolve later without
// making a historical receipt's own immutable snapshot dependent on it.
export const RECEIPT_RENDERER_VERSION = 1;

interface ReceiptLabels {
  receipt: string;
  date: string;
  item: string;
  qty: string;
  unitPrice: string;
  lineTotal: string;
  subtotal: string;
  discount: string;
  tax: string;
  fee: string;
  total: string;
  paymentMethod: string;
  thankYou: string;
  amountOriginal: string;
  amountPaid: string;
  remainingBalance: string;
  fullPayment: string;
  partialPayment: string;
  paymentReversal: string;
  supplier: string;
  purchaseOrder: string;
  warehouse: string;
  destinationBranch: string;
  originalReceipt: string;
}

// Translation confidence note, same as messageTemplates.ts's own: English/
// French/Spanish/Arabic written with high confidence; Somali is a
// functional first pass, not verified by a native speaker.
const LABELS: Record<SupportedLanguage, ReceiptLabels> = {
  en: {
    receipt: "Receipt", date: "Date", item: "Item", qty: "Qty", unitPrice: "Unit Price", lineTotal: "Line Total",
    subtotal: "Subtotal", discount: "Discount", tax: "Tax", fee: "Fee", total: "Total", paymentMethod: "Payment Method",
    thankYou: "Thank you for your business!", amountOriginal: "Original Amount", amountPaid: "Amount Paid",
    remainingBalance: "Remaining Balance", fullPayment: "Payment in Full", partialPayment: "Partial Payment",
    paymentReversal: "Payment Reversal", supplier: "Supplier", purchaseOrder: "Purchase Order", warehouse: "Warehouse",
    destinationBranch: "Destination Branch", originalReceipt: "Original Receipt",
  },
  so: {
    receipt: "Rasiid", date: "Taariikh", item: "Alaab", qty: "Tiro", unitPrice: "Qiimaha Halkii", lineTotal: "Wadarta Sadarka",
    subtotal: "Wadarta Hoose", discount: "Dhimis", tax: "Canshuur", fee: "Khidmad", total: "Wadarta Guud", paymentMethod: "Habka Lacag-bixinta",
    thankYou: "Waad ku mahadsan tahay ganacsigaaga!", amountOriginal: "Lacagta Asalka ah", amountPaid: "Lacagta la Bixiyay",
    remainingBalance: "Hadhaaga", fullPayment: "Lacag-bixin Buuxda", partialPayment: "Lacag-bixin Qayb ah",
    paymentReversal: "Celin Lacag-bixineed", supplier: "Alaab-siiyaha", purchaseOrder: "Amarka Iibsiga", warehouse: "Bakhaarka",
    destinationBranch: "Laanta la Diray", originalReceipt: "Rasiidka Asalka ah",
  },
  ar: {
    receipt: "إيصال", date: "التاريخ", item: "الصنف", qty: "الكمية", unitPrice: "سعر الوحدة", lineTotal: "إجمالي السطر",
    subtotal: "المجموع الفرعي", discount: "الخصم", tax: "الضريبة", fee: "الرسوم", total: "الإجمالي", paymentMethod: "طريقة الدفع",
    thankYou: "شكراً لتعاملكم معنا!", amountOriginal: "المبلغ الأصلي", amountPaid: "المبلغ المدفوع",
    remainingBalance: "الرصيد المتبقي", fullPayment: "دفعة كاملة", partialPayment: "دفعة جزئية",
    paymentReversal: "عكس الدفعة", supplier: "المورد", purchaseOrder: "أمر الشراء", warehouse: "المستودع",
    destinationBranch: "الفرع المستلم", originalReceipt: "الإيصال الأصلي",
  },
  fr: {
    receipt: "Reçu", date: "Date", item: "Article", qty: "Qté", unitPrice: "Prix Unitaire", lineTotal: "Total Ligne",
    subtotal: "Sous-total", discount: "Remise", tax: "Taxe", fee: "Frais", total: "Total", paymentMethod: "Mode de Paiement",
    thankYou: "Merci pour votre confiance !", amountOriginal: "Montant Initial", amountPaid: "Montant Payé",
    remainingBalance: "Solde Restant", fullPayment: "Paiement Intégral", partialPayment: "Paiement Partiel",
    paymentReversal: "Annulation de Paiement", supplier: "Fournisseur", purchaseOrder: "Bon de Commande", warehouse: "Entrepôt",
    destinationBranch: "Succursale de Destination", originalReceipt: "Reçu Original",
  },
  es: {
    receipt: "Recibo", date: "Fecha", item: "Artículo", qty: "Cant.", unitPrice: "Precio Unitario", lineTotal: "Total Línea",
    subtotal: "Subtotal", discount: "Descuento", tax: "Impuesto", fee: "Tarifa", total: "Total", paymentMethod: "Método de Pago",
    thankYou: "¡Gracias por su preferencia!", amountOriginal: "Monto Original", amountPaid: "Monto Pagado",
    remainingBalance: "Saldo Restante", fullPayment: "Pago Completo", partialPayment: "Pago Parcial",
    paymentReversal: "Reversión de Pago", supplier: "Proveedor", purchaseOrder: "Orden de Compra", warehouse: "Almacén",
    destinationBranch: "Sucursal de Destino", originalReceipt: "Recibo Original",
  },
};

function resolveLabels(language: string): ReceiptLabels {
  return isSupportedLanguage(language) ? LABELS[language] : LABELS.en;
}

// Formats an immutable (issuedAt UTC, businessTimezone) pair into a local
// display string, computed fresh on every render -- never stored. Because
// both inputs are themselves snapshotted on the receipt row, this is fully
// deterministic and immune to the business later changing its own
// timezone, or the viewer's own current timezone, per the Business
// Timezone + UTC requirement.
export function formatIssuedAtLocal(issuedAt: Date, businessTimezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: businessTimezone,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(issuedAt);
  } catch {
    // An invalid/unrecognized IANA zone string should never crash
    // rendering -- fall back to a UTC ISO representation instead.
    return issuedAt.toISOString();
  }
}

export interface ReceiptRenderInput {
  receiptNumber: string;
  receiptType: string;
  status: string;
  issuedAtLocal: string; // pre-formatted by the caller from (issuedAt, businessTimezone) -- rendering itself does no timezone math
  currencyCode: string;
  subtotal: string;
  discount: string;
  taxAmount: string;
  feeAmount: string;
  total: string;
  language: string;
  snapshot: ReceiptSnapshot;
}

// Plain-text, narrow-width-friendly (POS print) and equally valid as a
// WhatsApp message body -- no HTML, no PDF. Deterministic: identical input
// always produces identical output.
export function renderReceiptText(input: ReceiptRenderInput): string {
  const t = resolveLabels(input.language);
  const lines: string[] = [];

  lines.push(input.snapshot.business.name);
  if (input.snapshot.business.address) lines.push(input.snapshot.business.address);
  lines.push("");
  lines.push(`${t.receipt}: ${input.receiptNumber}`);
  lines.push(`${t.date}: ${input.issuedAtLocal}`);
  lines.push("");

  for (const item of input.snapshot.items) {
    const sizeLabel = item.size ? ` (${item.size})` : "";
    lines.push(`${item.productName}${sizeLabel}`);
    lines.push(`  ${item.quantity} x ${item.unitPrice} = ${item.lineTotal}`);
  }
  lines.push("");

  lines.push(`${t.subtotal}: ${input.currencyCode} ${input.subtotal}`);
  if (Number(input.discount) !== 0) lines.push(`${t.discount}: ${input.currencyCode} ${input.discount}`);
  if (Number(input.taxAmount) !== 0) lines.push(`${t.tax}: ${input.currencyCode} ${input.taxAmount}`);
  if (Number(input.feeAmount) !== 0) lines.push(`${t.fee}: ${input.currencyCode} ${input.feeAmount}`);
  lines.push(`${t.total}: ${input.currencyCode} ${input.total}`);

  if (input.snapshot.paymentMethod) lines.push(`${t.paymentMethod}: ${input.snapshot.paymentMethod}`);

  const dp = input.snapshot.debtPayment;
  if (dp) {
    lines.push("");
    lines.push(dp.isReversal ? t.paymentReversal : dp.isFullPayment ? t.fullPayment : t.partialPayment);
    lines.push(`${t.amountOriginal}: ${input.currencyCode} ${dp.amountOriginal}`);
    lines.push(`${t.amountPaid}: ${input.currencyCode} ${dp.amountPaidTotal}`);
    lines.push(`${t.remainingBalance}: ${input.currencyCode} ${dp.remainingBalance}`);
  }

  const wh = input.snapshot.warehouseStockOut;
  if (wh) {
    lines.push("");
    lines.push(`${t.warehouse}: ${wh.warehouseName}`);
    if (wh.destinationBranchName) lines.push(`${t.destinationBranch}: ${wh.destinationBranchName}`);
  }

  const grn = input.snapshot.supplierGoodsReceived;
  if (grn) {
    lines.push("");
    lines.push(`${t.supplier}: ${grn.supplierName}`);
    lines.push(`${t.purchaseOrder}: ${grn.poNumber}`);
  }

  const pos = input.snapshot.poSettlement;
  if (pos) {
    lines.push("");
    lines.push(`${t.supplier}: ${pos.supplierName}`);
    lines.push(`${t.purchaseOrder}: ${pos.poNumber}`);
  }

  const refund = input.snapshot.refund;
  if (refund) {
    lines.push("");
    lines.push(`${t.originalReceipt}: ${refund.originalReceiptNumber}`);
  }

  lines.push("");
  lines.push(t.thankYou);

  return lines.join("\n");
}
