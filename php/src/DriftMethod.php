<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/** How the check was done, so a report can be read without the code. */
enum DriftMethod: string
{
    case OpenApi = 'openapi';

    case Lexicon = 'lexicon';

    case RecordedShape = 'recorded-shape';

    case None = 'none';
}
