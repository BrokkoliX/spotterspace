import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';

import { AdSenseLoader } from '@/components/AdSenseLoader';
import { Analytics } from '@/components/Analytics';
import { CookieConsent } from '@/components/CookieConsent';
import { Footer } from '@/components/Footer';
import { Header } from '@/components/Header';
import { getWebBase } from '@/lib/og';
import { Providers, type ServerAuthState } from '@/lib/providers';

import './globals.css';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

// Always render fresh auth state server-side (no stale data)
export const dynamic = 'force-dynamic';

// Request-aware metadata. Using generateMetadata (not a static const) so that
// metadataBase is derived from the request's host headers in production.
// The `WEB_BASE_URL` env var is supposed to be set by CDK, but the live task
// def doesn't include it (CDK/deploy split-brain), so we can't rely on a
// build-time constant — we have to read the host at request time.
export async function generateMetadata(): Promise<Metadata> {
  const webBase = await getWebBase();
  return {
    metadataBase: new URL(webBase),
    // Per-page generateMetadata returns just the leaf title; this template
    // appends the brand suffix automatically.
    title: {
      default: 'SpotterSpace — Aviation Photography Community',
      template: '%s — SpotterSpace',
    },
    description: 'The premier platform for aviation photographers to share, discover, and connect.',
    icons: {
      icon: '/logo.png',
    },
    openGraph: {
      type: 'website',
      siteName: 'SpotterSpace',
      title: 'SpotterSpace — Aviation Photography Community',
      description:
        'The premier platform for aviation photographers to share, discover, and connect.',
    },
    twitter: {
      card: 'summary_large_image',
      title: 'SpotterSpace — Aviation Photography Community',
      description:
        'The premier platform for aviation photographers to share, discover, and connect.',
    },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Server-side auth hydration: fetch user data before render to avoid hydration flash.
  //
  // IMPORTANT: this runs on every page render (the layout is `force-dynamic`).
  // We MUST cap how long it can block, otherwise an upstream API stall (cold
  // start, DB burst throttle, deploy-in-progress) will hang the entire page
  // for minutes. On timeout/error we fall back to `user: null` and the client
  // re-hydrates via the `/api/auth/me` BFF route once it mounts.
  const SERVER_AUTH_TIMEOUT_MS = 3000;
  let serverAuth: ServerAuthState = { user: null };
  try {
    const cookieStore = await cookies();
    const accessToken = cookieStore.get('access_token')?.value;
    if (accessToken) {
      const res = await fetch(`${API_URL}/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          query: `
            query Me {
              me {
                id
                email
                username
                role
                sellerProfile { approved }
              }
            }
          `,
        }),
        signal: AbortSignal.timeout(SERVER_AUTH_TIMEOUT_MS),
      });
      const data = await res.json();
      if (data.data?.me) {
        serverAuth = { user: data.data.me };
      }
    }
  } catch {
    // Auth fetch failed or timed out — client will revalidate via /api/auth/me.
    // Intentionally swallowed: server-side hydration is a UX nicety, not a
    // correctness boundary. Auth is enforced by the API on every GraphQL call.
  }

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);return;}if(window.matchMedia('(prefers-color-scheme: light)').matches){document.documentElement.setAttribute('data-theme','light');}}catch(e){}})();`,
          }}
        />
        {/*
          Google Consent Mode v2 bootstrap. Must run BEFORE the AdSense/GA
          scripts so the consent signals are honored on first hit. Reads the
          stored choice (or falls back to deny-all) and sets the `default`
          consent state. The `wait_for_update` window lets ConsentProvider's
          post-mount `update` call apply if the stored value changed between
          SSR and hydration (rare, but defensive). Mirrors the logic in
          apps/web/src/lib/consent.ts (parseStoredConsent + toGtagConsent).
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){window.dataLayer=window.dataLayer||[];window.gtag=function(){window.dataLayer.push(arguments);};var stored=null;try{stored=localStorage.getItem('spotter_consent_v1');}catch(e){}var c={analytics:false,advertising:false};try{if(stored){var p=JSON.parse(stored);if(p&&p.v===1&&p.choices&&p.choices.necessary===true){c.analytics=p.choices.analytics===true;c.advertising=p.choices.advertising===true;}}}catch(e){}window.gtag('consent','default',{analytics_storage:c.analytics?'granted':'denied',ad_storage:c.advertising?'granted':'denied',ad_user_data:c.advertising?'granted':'denied',ad_personalization:c.advertising?'granted':'denied',ads_data_redaction:!c.advertising,wait_for_update:500});})();`,
          }}
        />
        {/*
          AdSense publisher script is now injected by <AdSenseLoader /> in the
          body, gated on advertising consent. The global <script> tag that
          used to live here would load AdSense for every visitor, including
          those who rejected advertising — which is the exact GDPR/ePrivacy
          violation this consent system exists to prevent.
        */}
      </head>
      <body>
        <Analytics />
        <Providers serverAuth={serverAuth}>
          <Header />
          <main style={{ flex: 1 }}>{children}</main>
          <Footer />
          {/*
            Must render INSIDE <Providers>: AdSenseLoader calls urql's
            useQuery and both components call useConsent, so they need the
            UrqlProvider and ConsentProvider contexts that Providers supplies.
          */}
          <AdSenseLoader />
          <CookieConsent />
        </Providers>
      </body>
    </html>
  );
}
