<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/** Whether a problem stops a call or merely warns about it. */
enum ProblemSeverity: string
{
    case Block = 'block';

    case Warn = 'warn';
}
