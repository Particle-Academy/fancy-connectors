<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/** One thing a drift check noticed. */
final readonly class DriftFinding
{
    public function __construct(
        public DriftFindingKind $kind,
        public string $detail,
        public ?string $operation = null,
    ) {}
}
