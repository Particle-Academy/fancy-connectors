<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/**
 * Whose credential this is.
 *
 * The distinction exists because getting it wrong means either asking for the
 * same app secret five times, or letting one account's token reach another's.
 */
enum CredentialScope: string
{
    /** One value for the whole installation — an OAuth app serves every account. */
    case Provider = 'provider';

    /** One value per connected account. */
    case Account = 'account';
}
