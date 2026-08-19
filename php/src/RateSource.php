<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/**
 * Whose number a rate limit is.
 *
 * A confident figure nobody can cite is worse than an honest one that is too
 * slow, because the honest one gets revised when evidence turns up and the
 * confident one gets quoted as a platform fact.
 */
enum RateSource: string
{
    /** The provider published it. Pair it with a Citation. */
    case Documented = 'documented';

    /** Our own guess, chosen to be safe rather than accurate. */
    case SelfImposed = 'self-imposed';
}
