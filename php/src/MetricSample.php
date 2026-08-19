<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/** One measurement of one thing we did. */
final readonly class MetricSample
{
    /**
     * @param  array<string,int|float>  $metrics  ONLY what the provider actually reported.
     *                                            Absent stays absent — build it with
     *                                            {@see Metrics::reported()}.
     */
    public function __construct(
        public string $ref,
        public string $at,
        public array $metrics,
    ) {}
}
