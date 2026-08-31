import { redirect } from 'next/navigation';

/**
 * `/portfolio` is gone; its UI now lives inside `/profile` as `PortfolioPanel`.
 *
 * The route is kept as a permanent redirect rather than deleted, because links to
 * it may already have been shared or bookmarked and a 404 is a worse answer than
 * the page the content actually moved to.
 *
 * A server-side redirect, so it costs no client JS and never flashes an empty
 * page. `/profile` handles the disconnected case itself, so there is nothing to
 * decide here — which is also why this does not need to be a client component.
 */
export default function PortfolioRedirectPage() {
  redirect('/profile');
}
