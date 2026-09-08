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
      className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"
    >
      <h2 id="api-docs-heading" className="text-lg font-semibold">
        API specification
      </h2>
      <p className="mt-1 text-sm text-zinc-600">
        Published by the Go control plane. The UI links to these URLs and does
        not re-host the document.
      </p>
      <ul className="mt-4 space-y-2 text-sm">
        <li>
          <a
            className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
            href={swaggerUrl}
          >
            Swagger landing page
          </a>
          <span className="ml-2 font-mono text-xs text-zinc-500">
            {swaggerUrl}
          </span>
        </li>
        <li>
          <a
            className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
            href={openApiJsonUrl}
          >
            OpenAPI JSON
          </a>
          <span className="ml-2 font-mono text-xs text-zinc-500">
            {openApiJsonUrl}
          </span>
        </li>
        <li>
          <a
            className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600"
            href={openApiYamlUrl}
          >
            OpenAPI YAML
          </a>
          <span className="ml-2 font-mono text-xs text-zinc-500">
            {openApiYamlUrl}
          </span>
        </li>
      </ul>
    </section>
  );
}
