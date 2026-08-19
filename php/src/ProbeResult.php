<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/** What one probe found, in the provider's own words where possible. */
final readonly class ProbeResult
{
    public function __construct(
        public string $connector,
        public ProbeOutcome $outcome,
        public string $detail,
        public ?int $status = null,
        public ?FailureKind $kind = null,
    ) {}
}
