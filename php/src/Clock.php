<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/**
 * The wall clock, as a seam, in milliseconds.
 *
 * Only the rate floor needs it. Rendering deliberately does NOT, because a
 * renderer that could read a clock could produce a different payload from the
 * one that was approved.
 */
interface Clock
{
    public function nowMs(): int;
}
