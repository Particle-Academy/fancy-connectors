<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/**
 * How one probe ended.
 *
 * `Skip` exists because offline must never be a failure. A check that goes red
 * on a train gets ignored, and is then worth nothing when it goes red for real.
 */
enum ProbeOutcome: string
{
    case Pass = 'pass';

    case Fail = 'fail';

    case Skip = 'skip';
}
