// Explicit access list, not a claim that content from these sites is trustworthy.
// Root names include their subdomains, consistently with native search filters.
// Changes are operator-reviewed source changes; the model cannot extend this list.
export const WEB_ALLOWED_DOMAINS = Object.freeze([
  'bilibili.com', 'b23.tv', 'hdslb.com', 'biliimg.com',
  'qq.com', 'qpic.cn', 'gtimg.cn',
  'baidu.com', 'zhihu.com', 'zhimg.com', 'douban.com', 'doubanio.com',
  'wikipedia.org', 'wikimedia.org',
  'github.com', 'githubusercontent.com', 'githubassets.com',
  'stackoverflow.com', 'stackexchange.com', 'sstatic.net',
  'cppreference.com', 'isocpp.org', 'cplusplus.com',
  'mozilla.org', 'python.org', 'nodejs.org', 'rust-lang.org',
  'microsoft.com', 'developers.google.com', 'cloud.google.com', 'gstatic.com',
  'openai.com', 'chatgpt.com', 'arxiv.org', 'acm.org', 'ieee.org', 'rfc-editor.org',
]);

export function assertAllowedWebDomain(url) {
  const host = url.hostname.toLowerCase();
  if (!WEB_ALLOWED_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`))) {
    throw new Error('WEB_DOMAIN_NOT_ALLOWED');
  }
  return url;
}
