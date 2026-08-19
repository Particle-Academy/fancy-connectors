<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/** A set of probes, summarised. Skips do not fail a report. */
final readonly class ProbeReport
{
    /** @param list<ProbeResult> $results */
    public function __construct(
        public array $results,
        public int $passed,
        public int $failed,
        public int $skipped,
    ) {}

    public function ok(): bool
    {
        return $this->failed === 0;
    }
}
