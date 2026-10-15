export type BotProtectionProvider =
  | "cloudflare"
  | "akamai"
  | "datadome"
  | "perimeterx"
  | "imperva"
  | "aws-waf"
  | "kasada"
  | "sucuri"
  | "f5"
  | "vercel"
  | "anubis"
  | "wordfence"
  /** A captcha or "verify you are human" page from an unidentified vendor. */
  | "unknown";

export interface BotProtectionDetection {
  provider: BotProtectionProvider;
  /** Human-readable description of the signal that triggered the detection. */
  reason: string;
}

export interface BotProtectionInput {
  status: number;
  headers: Headers;
  body: string;
}

/**
 * Successful (2xx) responses are only checked for body markers when the body is
 * at most this many characters. Challenge interstitials are tiny; real pages
 * that merely mention a vendor's domain are usually much larger.
 */
const SUCCESS_BODY_SCAN_LIMIT = 64_000;

/** Statuses bot protection vendors typically use for blocks and challenges. */
const BLOCK_STATUSES = new Set([401, 403, 405, 406, 429, 503]);

interface Context {
  status: number;
  headers: Headers;
  body: string;
  /** The response status was not 2xx. */
  isError: boolean;
  /** The status is one commonly used by vendors to block or challenge. */
  isBlockStatus: boolean;
  /** Strong body markers may be trusted for this response. */
  scanBody: boolean;
}

type Marker = string | RegExp;

interface Rule {
  provider: BotProtectionProvider;
  detect(ctx: Context): string | undefined;
}

const rules: Rule[] = [
  {
    provider: "cloudflare",
    detect(ctx) {
      const rayId = cloudflareRayId(ctx);
      const withRay = (reason: string) => (rayId ? `${reason}, Ray ID ${rayId}` : reason);

      const mitigated = ctx.headers.get("cf-mitigated");
      if (mitigated) return withRay(`cf-mitigated: ${mitigated} header`);

      if (ctx.scanBody) {
        const marker = findMarker(ctx.body, ["window._cf_chl_opt", "cf_chl_prog", "cf-chl-widget"]);
        if (marker) return withRay(`Cloudflare challenge page (${marker})`);
      }

      if (!ctx.isError || !isCloudflareResponse(ctx)) return undefined;

      // Cloudflare also serves its error page template for origin failures
      // (52x, 1016 DNS errors, ...), so classify the page rather than trusting
      // the template markup alone.
      const blockMarker = findMarker(ctx.body, [
        'data-translate="block_headline"',
        "Sorry, you have been blocked",
        "used Cloudflare to restrict access",
      ]);
      if (blockMarker) return withRay(`Cloudflare security block page (${blockMarker})`);

      const errorCode = cloudflareErrorCode(ctx.body);
      if (errorCode) {
        const description = CLOUDFLARE_ACCESS_ERRORS[errorCode];
        if (description) return withRay(`Cloudflare error ${errorCode}: ${description}`);
        return undefined;
      }

      const challengeMarker = findMarker(ctx.body, [
        /<title>\s*Just a moment\.\.\.\s*<\/title>/i,
        "challenges.cloudflare.com",
      ]);
      if (challengeMarker) return withRay(`Cloudflare challenge page (${challengeMarker})`);

      if (ctx.body.includes("Attention Required! | Cloudflare")) {
        return withRay("Cloudflare block page (Attention Required! | Cloudflare)");
      }

      return undefined;
    },
  },
  {
    provider: "akamai",
    detect(ctx) {
      if (ctx.scanBody) {
        const marker = findMarker(ctx.body, [
          "/_sec/cp_challenge/",
          "sec-if-cpt-container",
          "/_sec/verify?provider=interstitial",
        ]);
        if (marker) return `Akamai Bot Manager challenge (${marker})`;
      }

      if (ctx.isError) {
        if (ctx.body.includes("errors.edgesuite.net")) {
          return "Akamai access denied page (errors.edgesuite.net)";
        }

        const isAkamai =
          /akamai/i.test(ctx.headers.get("server") ?? "") || ctx.headers.has("akamai-grn");
        if (isAkamai && ctx.isBlockStatus && /Access Denied/i.test(ctx.body)) {
          return "Akamai access denied page";
        }
      }

      return undefined;
    },
  },
  {
    provider: "datadome",
    detect(ctx) {
      if (ctx.scanBody && ctx.body.includes("captcha-delivery.com")) {
        return "DataDome captcha page (captcha-delivery.com)";
      }

      if (ctx.isBlockStatus) {
        const header = ["x-datadome", "x-datadome-cid", "x-dd-b"].find((name) =>
          ctx.headers.has(name),
        );
        if (header) return `${header} header on HTTP ${ctx.status}`;
        if (/datadome/i.test(ctx.headers.get("server") ?? "")) {
          return `DataDome server header on HTTP ${ctx.status}`;
        }
      }

      return undefined;
    },
  },
  {
    provider: "perimeterx",
    detect(ctx) {
      if (ctx.scanBody) {
        const marker = findMarker(ctx.body, ["px-captcha", "captcha.px-cdn.net", "_pxCaptcha"]);
        if (marker) return `HUMAN (PerimeterX) captcha page (${marker})`;
      }

      if (ctx.isBlockStatus) {
        const marker = findMarker(ctx.body, ["_pxAppId", "px-cloud.net", "_pxhd", /perimeterx/i]);
        if (marker) return `HUMAN (PerimeterX) block page (${marker})`;
      }

      return undefined;
    },
  },
  {
    provider: "imperva",
    detect(ctx) {
      if (ctx.scanBody) {
        const marker = findMarker(ctx.body, [
          "_Incapsula_Resource",
          "Incapsula incident ID",
          "Request unsuccessful. Incapsula",
        ]);
        if (marker) return `Imperva (Incapsula) challenge page (${marker})`;
      }

      if (ctx.isBlockStatus) {
        const isImperva =
          ctx.headers.has("x-iinfo") || /incapsula|imperva/i.test(ctx.headers.get("x-cdn") ?? "");
        if (isImperva) return `Imperva headers on HTTP ${ctx.status}`;
      }

      return undefined;
    },
  },
  {
    provider: "aws-waf",
    detect(ctx) {
      const action = ctx.headers.get("x-amzn-waf-action");
      if (action) return `x-amzn-waf-action: ${action} header`;

      if (ctx.scanBody && ctx.body.includes("gokuProps")) {
        return "AWS WAF challenge page (gokuProps)";
      }

      if (ctx.isError && ctx.body.includes("AwsWafIntegration")) {
        return "AWS WAF challenge page (AwsWafIntegration)";
      }

      const isCloudFrontError = /error from cloudfront/i.test(ctx.headers.get("x-cache") ?? "");
      if (ctx.status === 403 && isCloudFrontError && /Request blocked/i.test(ctx.body)) {
        return "CloudFront request blocked page";
      }

      return undefined;
    },
  },
  {
    provider: "kasada",
    detect(ctx) {
      if (ctx.isBlockStatus) {
        for (const [name] of ctx.headers) {
          if (name.startsWith("x-kpsdk-")) return `${name} header on HTTP ${ctx.status}`;
        }
      }

      if (ctx.isError && ctx.body.includes("KPSDK")) {
        return "Kasada challenge page (KPSDK)";
      }

      return undefined;
    },
  },
  {
    provider: "sucuri",
    detect(ctx) {
      if (ctx.headers.has("x-sucuri-block")) return "x-sucuri-block header";

      if (ctx.isError && /Sucuri WebSite Firewall/i.test(ctx.body)) {
        return "Sucuri WebSite Firewall block page";
      }

      return undefined;
    },
  },
  {
    provider: "f5",
    detect(ctx) {
      if (ctx.scanBody && ctx.body.includes("The requested URL was rejected")) {
        return "F5 BIG-IP ASM rejection page";
      }

      return undefined;
    },
  },
  {
    provider: "vercel",
    detect(ctx) {
      const mitigated = ctx.headers.get("x-vercel-mitigated");
      if (mitigated) return `x-vercel-mitigated: ${mitigated} header`;

      if (ctx.scanBody && ctx.body.includes("Vercel Security Checkpoint")) {
        return "Vercel Security Checkpoint page";
      }

      return undefined;
    },
  },
  {
    provider: "anubis",
    detect(ctx) {
      if (ctx.scanBody) {
        const marker = findMarker(ctx.body, ['id="anubis_challenge"', "anubis_version"]);
        if (marker) return `Anubis proof-of-work challenge (${marker})`;
      }

      return undefined;
    },
  },
  {
    provider: "wordfence",
    detect(ctx) {
      if (ctx.isError) {
        const marker = findMarker(ctx.body, [
          "Generated by Wordfence",
          "Your access to this site has been limited by the site owner",
        ]);
        if (marker) return `Wordfence block page (${marker})`;
      }

      return undefined;
    },
  },
  {
    provider: "unknown",
    detect(ctx) {
      if (!ctx.isBlockStatus) return undefined;

      const marker = findMarker(ctx.body, [
        "hcaptcha.com",
        "google.com/recaptcha",
        "recaptcha/api.js",
        /verify (?:that )?you(?:'re| are) (?:a )?human/i,
        /are you a robot/i,
        /unusual traffic from your (?:computer|network)/i,
        /enable javascript and cookies to continue/i,
      ]);
      return marker ? `captcha or human verification page (${marker})` : undefined;
    },
  },
];

/** Cloudflare 1xxx errors that mean the visitor was denied, rather than an origin failure. */
const CLOUDFLARE_ACCESS_ERRORS: Record<string, string> = {
  "1005": "the site owner has banned your ASN",
  "1006": "the site owner has banned your IP address",
  "1007": "the site owner has banned your IP address",
  "1008": "the site owner has banned your IP address",
  "1009": "the site owner has banned your country or region",
  "1010": "the site owner has banned your browser signature",
  "1011": "hotlinking denied",
  "1012": "access denied",
  "1015": "you are being rate limited",
  "1020": "access denied by a firewall rule",
};

function isCloudflareResponse(ctx: Context): boolean {
  return (
    /cloudflare/i.test(ctx.headers.get("server") ?? "") ||
    ctx.headers.has("cf-ray") ||
    ctx.body.includes("/cdn-cgi/styles/cf.errors.css") ||
    ctx.body.includes("Cloudflare Ray ID")
  );
}

function cloudflareRayId(ctx: Context): string | undefined {
  const header = ctx.headers.get("cf-ray")?.split("-", 1)[0];
  if (header) return header;
  return /Cloudflare Ray ID:\s*(?:<[^>]*>\s*)*([0-9a-f]{16})/i.exec(ctx.body)?.[1];
}

function cloudflareErrorCode(body: string): string | undefined {
  return (
    /error code:?\s*(\d{3,4})\b/i.exec(body)?.[1] ??
    /class="cf-error-code">\s*(\d{3,4})\s*</.exec(body)?.[1]
  );
}

/**
 * Inspects a response for signs that it was blocked or challenged by bot
 * protection (Cloudflare, Akamai, DataDome, HUMAN/PerimeterX, Imperva, AWS
 * WAF, Kasada, Sucuri, F5, Vercel, Anubis, Wordfence, or a generic captcha).
 * Returns `undefined` when no known signal is present.
 */
export function detectBotProtection(input: BotProtectionInput): BotProtectionDetection | undefined {
  const isError = input.status < 200 || input.status > 299;
  const ctx: Context = {
    ...input,
    isError,
    isBlockStatus: BLOCK_STATUSES.has(input.status),
    scanBody: isError || input.body.length <= SUCCESS_BODY_SCAN_LIMIT,
  };

  for (const rule of rules) {
    const reason = rule.detect(ctx);
    if (reason) return { provider: rule.provider, reason };
  }

  return undefined;
}

function findMarker(body: string, markers: Marker[]): string | undefined {
  for (const marker of markers) {
    if (typeof marker === "string") {
      if (body.includes(marker)) return marker;
    } else {
      const match = marker.exec(body);
      if (match) return match[0];
    }
  }

  return undefined;
}
