<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/** The real clock. */
final class SystemClock implements Clock
{
    public function nowMs(): int
    {
        return (int) (microtime(true) * 1000);
    }
}
