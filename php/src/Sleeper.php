<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/**
 * The pause between two attempts, as a seam.
 *
 * Injectable so a test proves the real backoff SCHEDULE without waiting for it.
 * A test that actually slept would be slow enough that somebody would eventually
 * shorten the delays to speed it up, and then the thing under test would be the
 * shortened version rather than the shipped one.
 */
interface Sleeper
{
    public function sleepMs(int $milliseconds): void;
}
