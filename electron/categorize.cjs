const { headerValue } = require('./core.cjs');

/**
 * Inbox tabs, like Gmail: primary, promotions, social, updates.
 * Gmail accounts get the category Gmail itself chose (see sync.cjs); every other
 * account is sorted here, on this computer, from the sender and a few list headers.
 */
const CATEGORIES = ['primary', 'promotions', 'social', 'updates'];

const SOCIAL_DOMAINS = [
  'facebookmail.com', 'facebook.com', 'meta.com', 'instagram.com', 'linkedin.com', 'x.com', 'twitter.com', 'tiktok.com',
  'threads.net', 'pinterest.com', 'reddit.com', 'redditmail.com', 'snapchat.com', 'telegram.org', 'whatsapp.com', 'quora.com',
  'discord.com', 'discordapp.com', 'tumblr.com', 'youtube.com', 'meetup.com', 'nextdoor.com', 'vk.com', 'behance.net', 'dribbble.com',
];

const UPDATE_WORDS = /receipt|invoice|order|payment|transaction|statement|verify|verification|confirm|security|alert|password|sign[- ]?in|login|code|otp|shipped|shipping|delivery|delivered|booking|reservation|ticket|account|subscription|renewal|expir|bill|refund|report|notification|reminder|status|update on|إيصال|فاتورة|طلب|دفع|معاملة|كشف|تحقق|تأكيد|أمان|تنبيه|كلمة المرور|رمز|شحن|توصيل|حجز|اشتراك|تجديد|تذكير|حسابك/i;
const PROMO_WORDS = /sale|offer|discount|% off|deal|promo|coupon|free shipping|limited time|exclusive|newsletter|webinar|register now|black friday|cyber monday|new arrivals|shop|عرض|خصم|تخفيض|تنزيلات|كوبون|حصري|لفترة محدودة|سجل الآن|نشرة/i;
// Only addresses no person writes from; info@, hello@ or support@ can be a real client.
const NOREPLY = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|alerts?|notify|mailer[-_.]?daemon|postmaster|bounces?|automated|billing|news|newsletters?|updates?|marketing)([-_.+].*)?@/i;

function domainMatches(address, list) {
  const domain = String(address || '').toLowerCase().split('@')[1] || '';
  return list.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** Pick a tab for a message from what is known about it (headers are optional). */
function categorize({ fromAddress = '', from = '', subject = '', headers = '' } = {}) {
  const address = String(fromAddress || (String(from).match(/<([^>]+)>/)?.[1]) || from).toLowerCase().trim();
  if (domainMatches(address, SOCIAL_DOMAINS)) return 'social';
  const unsubscribe = headerValue(headers, 'list-unsubscribe');
  const listId = headerValue(headers, 'list-id');
  const precedence = headerValue(headers, 'precedence').toLowerCase();
  const autoSubmitted = headerValue(headers, 'auto-submitted').toLowerCase();
  const bulk = Boolean(unsubscribe) || precedence === 'bulk' || precedence === 'list';
  const text = String(subject || '');
  if (bulk) {
    if (UPDATE_WORDS.test(text) && !PROMO_WORDS.test(text)) return 'updates';
    if (listId && !unsubscribe) return 'updates';
    return 'promotions';
  }
  if (autoSubmitted && autoSubmitted !== 'no') return 'updates';
  if (NOREPLY.test(address)) return PROMO_WORDS.test(text) ? 'promotions' : 'updates';
  if (PROMO_WORDS.test(text) && /%|\$|AED|USD|€|£/.test(text)) return 'promotions';
  return 'primary';
}

module.exports = { CATEGORIES, categorize };
