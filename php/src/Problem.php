<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/** Something a connector's own validation found. */
final readonly class Problem
{
    public function __construct(
        public ProblemSeverity $severity,
        public string $message,
    ) {}
}
