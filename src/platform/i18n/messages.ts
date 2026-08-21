/**
 * UI copy.
 *
 * Every user-visible string lives here rather than in a component, because the product ships in
 * English first and in Amharic second, and retrofitting i18n across scattered JSX is the kind
 * of task that never gets done. The `am` catalogue is deliberately incomplete — `t()` falls
 * back to English per key, so a partial translation is a usable product rather than a broken one.
 */
export const LOCALES = ['en', 'am'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export const en = {
  'app.name': 'Distributor OS',
  'app.tagline': 'Inquiry to delivery, with less retyping',

  'nav.dashboard': 'Dashboard',
  'nav.customers': 'Customers',
  'nav.products': 'Products',
  'nav.activity': 'Activity',
  'nav.signOut': 'Sign out',

  'auth.signIn': 'Sign in',
  'auth.email': 'Email',
  'auth.password': 'Password',
  'auth.signingIn': 'Signing in…',
  'auth.invalidCredentials': 'That email and password do not match an account.',
  'auth.noMembership': 'This account is not a member of any organization.',
  'auth.inactive': 'This account has been deactivated.',

  'role.ownerAdmin': 'Owner / Admin',
  'role.salesManager': 'Sales Manager',
  'role.salesperson': 'Salesperson',
  'role.finance': 'Finance',
  'role.warehouse': 'Warehouse',

  'customer.title': 'Customers',
  'customer.new': 'New customer',
  'customer.companyName': 'Company name',
  'customer.contactName': 'Contact name',
  'customer.phone': 'Phone',
  'customer.email': 'Email',
  'customer.address': 'Address',
  'customer.creditStatus': 'Credit status',
  'customer.creditLimit': 'Credit limit',
  'customer.paymentTerms': 'Payment terms',
  'customer.preferredLanguage': 'Preferred language',
  'customer.notes': 'Notes',
  'customer.empty': 'No customers yet.',
  'customer.created': 'Customer created.',

  'credit.cashOnly': 'Cash only',
  'credit.creditAllowed': 'Credit allowed',
  'credit.suspended': 'Suspended',

  'product.title': 'Products',
  'product.new': 'New product',
  'product.sku': 'SKU',
  'product.name': 'Name',
  'product.category': 'Category',
  'product.unit': 'Unit',
  'product.price': 'Price',
  'product.taxRate': 'Tax rate',
  'product.available': 'Available',
  'product.reserved': 'Reserved',
  'product.reorderThreshold': 'Reorder at',
  'product.aliases': 'Aliases',
  'product.aliasesHint': 'Alternative names customers use. One per line.',
  'product.empty': 'No products yet.',
  'product.lowStock': 'Low stock',
  'product.inactive': 'Inactive',
  'product.adjustStock': 'Adjust stock',
  'product.adjustment': 'Change',
  'product.adjustmentReason': 'Reason',
  'product.stockHistory': 'Stock history',

  'nav.inquiries': 'Inquiries',

  'inquiry.title': 'Inquiries',
  'inquiry.new': 'New inquiry',
  'inquiry.rawMessage': 'Customer message',
  'inquiry.rawMessageHint': 'Paste exactly what the customer sent. It is stored unchanged.',
  'inquiry.channel': 'Channel',
  'inquiry.customer': 'Customer',
  'inquiry.customerOptional': 'Customer (optional)',
  'inquiry.customerUnknown': 'Not linked to a customer',
  'inquiry.empty': 'No inquiries yet.',
  'inquiry.originalMessage': 'Original message',
  'inquiry.parsedContext': 'Interpretation',
  'inquiry.intent': 'Intent',
  'inquiry.language': 'Language',
  'inquiry.destination': 'Destination',
  'inquiry.requestedItems': 'Requested items',
  'inquiry.parse': 'Run parse',
  'inquiry.reparse': 'Parse again',
  'inquiry.parsing': 'Parsing…',
  'inquiry.parseFailed': 'The parser could not read this message',
  'inquiry.noItems': 'The parser found no requested items in this message.',
  'inquiry.markReady': 'Mark ready for quotation',
  'inquiry.ready': 'Ready for quotation',
  'inquiry.readyExplain': 'A quotation can be drafted from this inquiry in the next phase.',
  'inquiry.blockers': 'Before this can be marked ready',
  'inquiry.warnings': 'Worth knowing',
  'inquiry.addItem': 'Add a line the parser missed',
  'inquiry.aiSuggested': 'AI suggested',
  'inquiry.addedByHand': 'Added by hand',

  'item.requested': 'Requested',
  'item.proposed': 'Proposed product',
  'item.confidence': 'Confidence',
  'item.reason': 'Why',
  'item.available': 'Available',
  'item.price': 'Price',
  'item.confirm': 'Confirm',
  'item.change': 'Change product',
  'item.unresolved': 'Mark unresolved',
  'item.remove': 'Not a product',
  'item.chooseProduct': 'Choose the product',
  'item.otherCandidates': 'Possible products',
  'item.noMatch': 'No product identified',
  'item.shortBy': 'Short by',
  'item.unitMismatch': 'Unit does not match',
  'item.quantity': 'Quantity',
  'item.updateQuantity': 'Update',

  'status.received': 'Received',
  'status.parsing': 'Parsing',
  'status.needs_review': 'Needs review',
  'status.ready_for_quote': 'Ready for quote',
  'status.parse_failed': 'Parse failed',
  'status.cancelled': 'Cancelled',

  'review.suggested': 'Suggested',
  'review.confirmed': 'Confirmed',
  'review.corrected': 'Corrected',
  'review.unresolved': 'Unresolved',
  'review.rejected': 'Removed',
  'review.ambiguous': 'Ambiguous',

  'nav.quotations': 'Quotations',

  'quote.title': 'Quotations',
  'quote.new': 'Create quotation',
  'quote.number': 'Number',
  'quote.customer': 'Customer',
  'quote.status': 'Status',
  'quote.total': 'Total',
  'quote.validUntil': 'Valid until',
  'quote.empty': 'No quotations yet.',
  'quote.sourceInquiry': 'From inquiry',
  'quote.lines': 'Lines',
  'quote.listPrice': 'List price',
  'quote.discount': 'Discount',
  'quote.quotedPrice': 'Quoted price',
  'quote.lineTax': 'Tax',
  'quote.lineTotal': 'Line total',
  'quote.quantity': 'Quantity',
  'quote.unit': 'Unit',
  'quote.stockContext': 'In stock now',
  'quote.subtotal': 'Subtotal',
  'quote.discountTotal': 'Discounts',
  'quote.deliveryFee': 'Delivery charge',
  'quote.deliveryTax': 'Tax on delivery',
  'quote.taxTotal': 'VAT',
  'quote.grandTotal': 'Total',
  'quote.paymentTerms': 'Payment terms',
  'quote.cash': 'Cash',
  'quote.credit7': 'Credit — 7 days',
  'quote.credit15': 'Credit — 15 days',
  'quote.credit30': 'Credit — 30 days',
  'quote.notesCustomer': 'Notes for the customer',
  'quote.notesInternal': 'Internal notes',
  'quote.addLine': 'Add a product',
  'quote.removeLine': 'Remove',
  'quote.priceMoved': 'Catalogue price has changed since this was quoted',
  'quote.snapshotNote':
    'Prices on this quotation were fixed when it was drafted. Changing the catalogue does not change them.',

  'quote.approval': 'Approval',
  'quote.approvalSalesperson': 'A salesperson may approve this',
  'quote.approvalManager': 'A sales manager must approve this',
  'quote.approvalBlocked': 'This cannot be approved as it stands',
  'quote.approvedBy': 'Approved',
  'quote.approvalInvalidated': 'Approval no longer applies — the figures changed',
  'quote.approvalHistory': 'Approval history',
  'quote.notYours': 'Your role cannot approve at this level',
  'quote.reasonForRejection': 'Why are you rejecting it?',

  'quote.actionSubmit': 'Submit for approval',
  'quote.actionApprove': 'Approve',
  'quote.actionReject': 'Reject',
  'quote.actionMarkSent': 'Mark as sent',
  'quote.actionCancel': 'Cancel quotation',
  'quote.sentNote': 'Recorded as sent by hand. Nothing was transmitted by this system.',

  'quoteStatus.draft': 'Draft',
  'quoteStatus.pending_approval': 'Awaiting approval',
  'quoteStatus.approved': 'Approved',
  'quoteStatus.sent': 'Sent',
  'quoteStatus.accepted': 'Accepted',
  'quoteStatus.rejected': 'Rejected',
  'quoteStatus.expired': 'Expired',
  'quoteStatus.superseded': 'Superseded',
  'quoteStatus.cancelled': 'Cancelled',

  'activity.title': 'Activity',
  'activity.empty': 'Nothing recorded yet.',
  'activity.actor': 'Who',
  'activity.action': 'What',
  'activity.when': 'When',
  'activity.system': 'System',

  'action.save': 'Save',
  'action.cancel': 'Cancel',
  'action.create': 'Create',
  'action.back': 'Back',
  'action.search': 'Search',

  'error.required': 'This field is required.',
  'error.generic': 'Something went wrong. Nothing was changed.',
  'error.forbidden': 'Your role does not allow this.',
  'error.notFound': 'Not found.',

  'dashboard.welcome': 'Welcome',
  'dashboard.phaseNotice':
    'Foundation only. Inquiries, quotations, orders, payments and delivery arrive in later phases.',
  'dashboard.customers': 'Customers',
  'dashboard.products': 'Products',
  'dashboard.lowStock': 'Below reorder threshold',
} as const;

export type MessageKey = keyof typeof en;

/**
 * Amharic. Partial on purpose — see the note above. Keys absent here fall back to English.
 */
export const am: Partial<Record<MessageKey, string>> = {
  'nav.dashboard': 'ዳሽቦርድ',
  'nav.customers': 'ደንበኞች',
  'nav.inquiries': 'ጥያቄዎች',
  'nav.quotations': 'ዋጋዎች',
  'nav.products': 'ምርቶች',
  'nav.activity': 'እንቅስቃሴ',
  'nav.signOut': 'ውጣ',
  'auth.signIn': 'ግባ',
  'auth.email': 'ኢሜይል',
  'auth.password': 'የይለፍ ቃል',
  'action.save': 'አስቀምጥ',
  'action.cancel': 'ሰርዝ',
  'action.create': 'ፍጠር',
  'action.back': 'ተመለስ',
};

const CATALOGUES: Record<Locale, Partial<Record<MessageKey, string>>> = { en, am };

export function t(key: MessageKey, locale: Locale = DEFAULT_LOCALE): string {
  return CATALOGUES[locale]?.[key] ?? en[key];
}
