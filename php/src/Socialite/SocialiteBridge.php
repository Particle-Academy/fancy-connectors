<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors\Socialite;

use ParticleAcademy\Connectors\Mode;
use ParticleAcademy\Connectors\ResolvedConnection;

/**
 * The seam between Laravel Socialite and a connector.
 *
 * ## Socialite is an OAuth dance. It is not a client.
 *
 * Socialite redirects, handles the callback, exchanges the code, and hands back
 * a user carrying a token. It has no opinion about what you then do with the
 * provider's API — and its first-party drivers plus the community set are a
 * large amount of correct, maintained onboarding code we have no business
 * rewriting.
 *
 * So the line is exactly here:
 *
 * | | owns |
 * |---|---|
 * | **Socialite** | the redirect, the callback, the code exchange, refresh where its driver implements one, and the identity |
 * | **fancy-connectors** | everything after a token exists — the request, the auth placement, the failure classification, idempotency, rendering, measurement, drift |
 *
 * This class is the mapper between them: a Socialite user in, the credential map
 * a `ProviderAdapter` declared out. It is not a wrapper, and it deliberately
 * does not grow.
 *
 * ## Why Socialite is not a dependency
 *
 * It is a `suggest`, and every entry point here is guarded by `class_exists`.
 * Requiring it would make every Node-backed consumer, and every PHP consumer who
 * is not on Laravel, carry an OAuth package they cannot use — for a seam that is
 * two functions wide.
 *
 * ## And why token refresh is not implemented here
 *
 * Where Socialite refreshes, the host refreshes and passes the new token in.
 * Where it does not, the adapter's `credentialLifetimeDays` says so and the
 * honest answer is a person re-authorising. A package that silently minted
 * credentials would be doing the one thing this whole design refuses: acting on
 * a claim about the world that only a person can make.
 */
final class SocialiteBridge
{
    /** True when the host actually has Socialite installed. */
    public static function available(): bool
    {
        return class_exists(\Laravel\Socialite\Facades\Socialite::class)
            || interface_exists(\Laravel\Socialite\Contracts\User::class);
    }

    /**
     * Turn a Socialite user into a resolved connection a connector can use.
     *
     * `$map` names which credential key on the adapter each Socialite field
     * feeds — declared by the caller rather than guessed, because the adapter
     * owns its own credential names and a bridge that invented them would be a
     * second, silent source of truth for the one thing that must have only one.
     *
     * The default covers the common case: a bearer token under `token`.
     *
     * @param  object  $user  a `Laravel\Socialite\Contracts\User`. Typed loosely on
     *                        purpose — the package must compile and its tests must run
     *                        with Socialite absent, which a hard type hint would prevent.
     * @param  array<string,string>  $map  socialite property => credential key
     */
    public static function connectionFrom(
        object $user,
        string $service,
        array $map = ['token' => 'token', 'refreshToken' => 'refreshToken'],
        Mode $mode = Mode::Live,
        ?string $baseUrl = null,
        ?string $connectionId = null,
    ): ResolvedConnection {
        $credentials = [];

        foreach ($map as $property => $key) {
            $value = $user->{$property} ?? null;

            // An absent value is OMITTED, never stored as an empty string. A
            // blank credential passes a `!isset` check and fails at the
            // provider, which is the most expensive place to find out; the
            // resolver's `requires` check catches an omission immediately.
            if (is_string($value) && $value !== '') {
                $credentials[$key] = $value;
            }
        }

        return new ResolvedConnection(
            id: $connectionId ?? $service,
            service: $service,
            mode: $mode,
            credentials: $credentials,
            baseUrl: $baseUrl,
        );
    }

    /**
     * Whether a Socialite token is worth trying, given what the adapter said.
     *
     * Answers `false` only when the provider publishes a lifetime AND that
     * lifetime has elapsed since the token was issued. Everything else is
     * `true`, including "no published expiry" — because **"no known expiry" is
     * not "cannot stop working"**, and a bridge that reported a revoked
     * credential as fine would be making a claim it cannot support.
     *
     * This is a hint for a setup surface, never a gate. The only thing that
     * knows whether a credential works is the provider, and the way to ask is
     * the adapter's `verify`.
     */
    public static function looksCurrent(
        ?int $credentialLifetimeDays,
        \DateTimeImmutable $issuedAt,
        ?\DateTimeImmutable $now = null,
    ): bool {
        if ($credentialLifetimeDays === null) {
            return true;
        }

        $now ??= new \DateTimeImmutable;
        $elapsed = $now->getTimestamp() - $issuedAt->getTimestamp();

        return $elapsed < $credentialLifetimeDays * 86400;
    }
}
