<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/** The real pause. `usleep` takes microseconds; the seam speaks milliseconds. */
final class SystemSleeper implements Sleeper
{
    public function sleepMs(int $milliseconds): void
    {
        if ($milliseconds > 0) {
            usleep($milliseconds * 1000);
        }
    }
}
