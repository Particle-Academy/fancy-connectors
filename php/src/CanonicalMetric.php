<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/**
 * What a metric IS across providers, where an honest equivalent exists.
 *
 * A like and a favourite are the same act; a repost and a boost are the same
 * act; a quote often has no equivalent, and NULL says so — which is more useful
 * than a mapping somebody invented to make a table line up.
 */
enum CanonicalMetric: string
{
    case Like = 'like';

    case Share = 'share';

    case Reply = 'reply';

    case Quote = 'quote';

    case View = 'view';
}
