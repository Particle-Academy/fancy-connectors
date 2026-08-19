<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/**
 * One operation a connector calls.
 *
 * The `path` is the TEMPLATE, matching the provider's own documentation, so it
 * can be looked up in a spec: `/v1/charges/{charge}`, not the interpolated URL.
 * An interpolated path matches nothing and reports every operation as missing,
 * which is a drift report that cries wolf on its first run.
 */
final readonly class ContractOperation
{
    /**
     * @param  string  $operation  stable name, matching the connector's own operation id
     * @param  list<string>  $sends  request fields the connector SENDS. Drift here breaks writes.
     * @param  list<string>  $reads  response fields the connector READS. Drift here breaks
     *                               reads SILENTLY, which is the dangerous half.
     */
    public function __construct(
        public string $operation,
        public HttpMethod $method,
        public string $path,
        public array $sends = [],
        public array $reads = [],
    ) {}
}
