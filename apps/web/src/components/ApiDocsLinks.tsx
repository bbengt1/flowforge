import {
  FF_SETTINGS_LINK_CLASS,
  FF_SETTINGS_MUTED_CLASS,
  FF_SETTINGS_PANEL_CLASS,
  FF_SETTINGS_TITLE_CLASS,
} from "@/lib/settings-wizard-visual";

type ApiDocsLinksProps = {
  swaggerUrl: string;
  openApiJsonUrl: string;
  openApiYamlUrl: string;
};

export function ApiDocsLinks({
  swaggerUrl,
  openApiJsonUrl,
  openApiYamlUrl,
}: ApiDocsLinksProps) {
  return (
    <section
      aria-labelledby="api-docs-heading"
      className={FF_SETTINGS_PANEL_CLASS}
    >
      <h2 id="api-docs-heading" className={`text-lg ${FF_SETTINGS_TITLE_CLASS}`}>
        API specification
      </h2>
      <p className={`mt-1 text-sm ${FF_SETTINGS_MUTED_CLASS}`}>
        Published by the Go control plane. The UI links to these URLs and does
        not re-host the document.
      </p>
      <ul className="mt-4 space-y-2 text-sm">
        <li>
          <a className={FF_SETTINGS_LINK_CLASS} href={swaggerUrl}>
            Swagger landing page
          </a>
          <span className={`ml-2 font-mono text-xs ${FF_SETTINGS_MUTED_CLASS}`}>
            {swaggerUrl}
          </span>
        </li>
        <li>
          <a className={FF_SETTINGS_LINK_CLASS} href={openApiJsonUrl}>
            OpenAPI JSON
          </a>
          <span className={`ml-2 font-mono text-xs ${FF_SETTINGS_MUTED_CLASS}`}>
            {openApiJsonUrl}
          </span>
        </li>
        <li>
          <a className={FF_SETTINGS_LINK_CLASS} href={openApiYamlUrl}>
            OpenAPI YAML
          </a>
          <span className={`ml-2 font-mono text-xs ${FF_SETTINGS_MUTED_CLASS}`}>
            {openApiYamlUrl}
          </span>
        </li>
      </ul>
    </section>
  );
}
