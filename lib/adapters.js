/**
 * Site Adapters — per-site guidance injected into the first user message when
 * operating on known high-traffic sites. Prevents the model from wasting steps
 * discovering non-obvious quirks on its own.
 *
 * Each adapter:
 *   - match(url): boolean — does this adapter apply to the current URL?
 *   - name: short identifier
 *   - category: 'general' | 'finance'
 *   - notes: short bulleted guidance (4–8 bullets max)
 */

export const UNIVERSAL_PREAMBLE = `[Universal guidance]
COOKIE / CONSENT BANNERS (OneTrust, Didomi, Cookiebot, etc.) often block interaction until dismissed.
- Priority: click "Reject all" > "Reject non-essential" / "Only necessary".
- If only "Accept all" / "I agree" is exposed, click it to unblock.
- After dismissing, re-read the page before acting. Do NOT summarize banner text as page content.

PAYWALLS / SIGN-IN WALLS: "Subscribe to continue", blurred overlay, short preview.
- STOP and tell the user. Do NOT attempt bypass (archive.is, 12ft.io, clearing cookies, etc.).
- Offer alternatives: search free sources, ask if user has subscription.

PDF TABS: If the page is a PDF, content scripts cannot reach it. Inform the user.
Navigation-preceding clicks: after clicking a link, wait for the page to load before reading.`;

const ADAPTERS = [
  /* ─── Code & Dev Tools ─────────────────────────────────────── */
  {
    name: 'github', category: 'general',
    match: url => /^https?:\/\/(www\.)?github\.com\//.test(url),
    notes: `
- Release creation: navigate to /<owner>/<repo>/releases/new. The tag selector is a combobox — click "Choose a tag", type the tag, then click "Create new tag".
- Release body is a CodeMirror editor, not a textarea. Click the editor surface first, then type.
- The green "Publish release" button is at the bottom; "Save draft" is gray next to it — don't confuse them.
- Issue/PR comments use the same CodeMirror editor.
- File browser: pressing "t" opens the fuzzy file finder. Raw file URLs: https://github.com/<owner>/<repo>/raw/<branch>/<path>.`,
  },
  {
    name: 'gitlab', category: 'general',
    match: url => /^https?:\/\/(www\.)?gitlab\.com\//.test(url),
    notes: `
- Releases: /<group>/<project>/-/releases/new. Tag must exist or be created inline.
- Merge requests: the "Merge" button may be disabled until pipelines pass — check pipeline status first.`,
  },
  {
    name: 'stackoverflow', category: 'general',
    match: url => /^https?:\/\/(.*\.)?stackoverflow\.com\//.test(url) || /^https?:\/\/(.*\.)?stackexchange\.com\//.test(url),
    notes: `
- Answers are sorted by votes; the accepted answer (green check) may not be the highest-voted.
- Code blocks use 4-space indentation or triple-backtick fences — preserve indentation exactly.`,
  },
  {
    name: 'hackernews', category: 'general',
    match: url => /^https?:\/\/news\.ycombinator\.com\//.test(url),
    notes: `
- Comments are nested by indentation. "More" link at bottom loads next page with a "next" token.`,
  },

  /* ─── Productivity ──────────────────────────────────────────── */
  {
    name: 'gmail', category: 'general',
    match: url => /^https?:\/\/mail\.google\.com\//.test(url),
    notes: `
- The body is a contenteditable div, not a textarea. Click into it before typing.
- Search operators: from:, to:, subject:, has:attachment, before:YYYY/MM/DD.
- Threads collapse old messages — click to expand.`,
  },
  {
    name: 'google-docs', category: 'general',
    match: url => /^https?:\/\/docs\.google\.com\/document\//.test(url),
    notes: `
- The document body is a canvas-rendered editor. Direct DOM typing usually fails. Use the textbox that appears when clicking into the doc.
- Comments are in the right margin; click the comment icon to open them.`,
  },
  {
    name: 'google-calendar', category: 'general',
    match: url => /^https?:\/\/calendar\.google\.com\//.test(url),
    notes: `
- Creating an event: click an empty time slot or press "c". Guests field is a contact picker.
- Save button asks about notifying guests — read the modal.`,
  },
  {
    name: 'slack', category: 'general',
    match: url => /^https?:\/\/app\.slack\.com\//.test(url) || /\.slack\.com\//.test(url),
    notes: `
- Slack virtualizes messages — items off-screen aren't in the DOM. Scroll to load more.
- Message composer is contenteditable; Enter sends, Shift+Enter for newline.`,
  },
  {
    name: 'notion', category: 'general',
    match: url => /^https?:\/\/(www\.)?notion\.so\//.test(url),
    notes: `
- Every block is contenteditable; Enter creates a new block, "/" opens the slash menu.
- Database views are virtualized — rows off-screen aren't in the DOM. Search within the database.`,
  },
  {
    name: 'jira', category: 'general',
    match: url => /\.atlassian\.net\//.test(url),
    notes: `
- Issue keys (PROJ-123) open issues in a side panel. Status changes go through a workflow dropdown.
- The description editor is rich-text with its own toolbar. JQL search at /issues/?jql=... is powerful.`,
  },

  /* ─── Social & Content ──────────────────────────────────────── */
  {
    name: 'twitter', category: 'general',
    match: url => /^https?:\/\/(www\.)?(twitter\.com|x\.com)\//.test(url),
    notes: `
- The composer is contenteditable, not a textarea. Character count at 280 (or higher for Premium).
- The timeline is virtualized — use search to find specific tweets, don't scroll endlessly.`,
  },
  {
    name: 'linkedin', category: 'general',
    match: url => /^https?:\/\/(www\.)?linkedin\.com\//.test(url),
    notes: `
- LinkedIn lazy-loads everything; scroll to populate feed/profile. Content often in modal detail panes.
- Connect button has "Send without a note" prompt — read it before clicking.
- Messages: composer is contenteditable. Press Enter to send, or find the Send button in footer.`,
  },
  {
    name: 'reddit', category: 'general',
    match: url => /^https?:\/\/(www\.|old\.|new\.)?reddit\.com\//.test(url),
    notes: `
- Prefer old.reddit.com — simpler DOM for automation. old and new reddit have completely different DOMs.
- Comments are deeply nested; "load more comments" needs clicking to expand.`,
  },
  {
    name: 'youtube', category: 'general',
    match: url => /^https?:\/\/((www|m)\.)?youtube\.com\//.test(url) || /^https?:\/\/youtu\.be\//.test(url),
    notes: `
- Keyboard shortcuts: k=play/pause, j/l=±10s, ←/→=±5s, m=mute.
- Read the transcript first when available. Click "Show transcript" in description, then scroll the panel.
- Comments load lazily after scrolling past the video.`,
  },
  {
    name: 'medium', category: 'general',
    match: url => /^https?:\/\/(.*\.)?medium\.com\//.test(url),
    notes: `
- Member-only articles show a paywall mid-article. The "Read more" gate means paywall, not end of article.
- Editor: the whole article is ONE contenteditable containing title and body blocks. Don't replace the whole thing.`,
  },

  /* ─── Commerce ──────────────────────────────────────────────── */
  {
    name: 'amazon', category: 'general',
    match: url => /^https?:\/\/(www\.|smile\.)?amazon\.(com|co\.uk|de|fr|ca|com\.au|co\.jp|in)\//.test(url),
    notes: `
- "Add to Cart" and "Buy Now" are different — "Buy Now" skips the cart and goes to checkout. Be careful.
- Product variants (size, color) are buttons above the price; selecting them changes the URL and price.`,
  },

  /* ─── Cloud Consoles ────────────────────────────────────────── */
  {
    name: 'aws', category: 'general',
    match: url => /^https?:\/\/.*\.console\.aws\.amazon\.com\//.test(url) || /^https?:\/\/console\.aws\.amazon\.com\//.test(url),
    notes: `
- Region selector in top-right persists in URL — resources are region-scoped; check before searching.
- Most "Create" actions span multi-page wizards. Defaults often cost money. Tags matter for billing.`,
  },
  {
    name: 'gcp', category: 'general',
    match: url => /^https?:\/\/console\.cloud\.google\.com\//.test(url),
    notes: `
- Project selector in top bar — every action is project-scoped. Confirm the project before destructive actions.
- Many services prompt to enable an API on first use; that's a one-time click but takes 30+ seconds.`,
  },
  {
    name: 'vercel', category: 'general',
    match: url => /^https?:\/\/vercel\.com\//.test(url),
    notes: `
- Dashboard is at vercel.com/dashboard. Project settings open from the project card, not the domain view.
- Deployments list filters by branch/environment at the top.`,
  },

  /* ─── WordPress ─────────────────────────────────────────────── */
  {
    name: 'wordpress', category: 'general',
    match: url => /^https?:\/\/[^/]+\/(wp-admin|wp-login\.php)(\/|$|\?)/.test(url),
    notes: `
- The first interactive element on every admin page is a skip-to-content link — clicking it does nothing.
- Two navigation surfaces: top admin bar (shortcuts) and left sidebar (primary menu). Sidebar items have hover-expanded sub-items.
- Login pages: #user_login (username), #user_pass (password), #wp-submit (submit). Never echo credentials in summaries.
- Localized labels: match URL paths rather than visible text when the site is in a non-English language.`,
  },

  /* ─── Finance (extra caution) ───────────────────────────────── */
  {
    name: 'stripe', category: 'finance',
    match: url => /^https?:\/\/dashboard\.stripe\.com\//.test(url),
    notes: `
[FINANCE / HIGH-STAKES] — confirmation is required before every click/type.
- Product catalog: "Export" exports to CSV, does NOT edit. "Create product" is a separate button.
- Payments and payouts are separate sections. Customer details show subscriptions AND one-off invoices.
- Test mode vs live mode: check the toggle at the top-left. Test mode data is NOT real.`,
  },
  {
    name: 'coinbase', category: 'finance',
    match: url => /^https?:\/\/(www\.|pro\.)?coinbase\.com\//.test(url),
    notes: `
[FINANCE / HIGH-STAKES] — NEVER buy/sell/convert without explicit user direction and re-confirmation.
- Portfolio view shows balances; "Trade" tab is for buy/sell. "Send/Receive" is for transfers.
- The confirmation screen shows fees AND final amount — read it carefully before clicking Confirm.`,
  },
  {
    name: 'tradingview', category: 'finance',
    match: url => /^https?:\/\/(www\.)?tradingview\.com\//.test(url),
    notes: `
- The chart is a canvas element; indicators/formatted text are rendered as overlays, not standard DOM.
- Read the data panel / legend / watchlist for structured data rather than trying to OCR the chart.
- Alerts: the alert panel is at the right sidebar; each alert has an edit/delete toggle.`,
  },
];

/**
 * Find the first adapter whose match(url) returns true.
 */
export function getActiveAdapter(url) {
  if (!url) return null;
  for (const a of ADAPTERS) {
    try { if (a.match(url)) return a; } catch {}
  }
  return null;
}

/**
 * Get a printable list of adapter names (for settings UI).
 */
export function listAdapters() {
  return ADAPTERS.map(a => ({ name: a.name, category: a.category }));
}