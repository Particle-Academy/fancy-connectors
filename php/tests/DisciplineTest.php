<?php

declare(strict_types=1);

/**
 * The three promises this package makes about itself, asserted rather than
 * intended.
 *
 * Each of these is the kind of rule that is true on the day it is written and
 * quietly stops being true a year later, because breaking it is convenient and
 * nothing complains. A scanner complains.
 */
$sources = static function (): array {
    $files = [];
    $dir = new RecursiveIteratorIterator(new RecursiveDirectoryIterator(__DIR__.'/../src'));

    foreach ($dir as $file) {
        if ($file->isFile() && $file->getExtension() === 'php') {
            $files[$file->getPathname()] = (string) file_get_contents($file->getPathname());
        }
    }

    return $files;
};

/** Strip comments, so a docblock may DISCUSS the environment without tripping the scan. */
$codeOnly = static function (string $source): string {
    $out = '';

    foreach (token_get_all($source) as $token) {
        if (is_array($token) && in_array($token[0], [T_COMMENT, T_DOC_COMMENT], true)) {
            continue;
        }

        $out .= is_array($token) ? $token[1] : $token;
    }

    return $out;
};

it('never reads the environment for a credential', function () use ($sources, $codeOnly) {
    // Credentials are ARGUMENTS. A package that reached for the environment
    // itself would bypass the host's storage discipline entirely — and the host
    // is where a whitelist, a secret manager or an audit log actually lives.
    $offenders = [];

    foreach ($sources() as $path => $source) {
        $code = $codeOnly($source);

        foreach (['getenv', '$_ENV', '$_SERVER', 'apache_getenv'] as $needle) {
            if (str_contains($code, $needle)) {
                $offenders[] = basename($path).' uses '.$needle;
            }
        }
    }

    expect($offenders)->toBe([]);
});

it('never contacts a URL of its own', function () use ($sources, $codeOnly) {
    // No telemetry, no phone-home, no URL a caller did not supply. The drift
    // checker deliberately does NOT fetch: the caller fetches and passes the
    // document in, so a scheduled check cannot become an outbound connection
    // nobody asked for.
    $offenders = [];

    foreach ($sources() as $path => $source) {
        $code = $codeOnly($source);

        // A scheme followed by slashes and then a HOST character. Written this
        // way so it still fires on an escaped literal inside a string, while
        // ignoring `Text`'s URL-DETECTION pattern, whose next character after
        // the slashes is a backslash rather than a host.
        if (preg_match('#https?:[\\\\/]+\w#', $code) === 1) {
            $offenders[] = basename($path).' carries a literal URL';
        }

        // CurlTransport is the one file allowed to open a socket, and only to a
        // URL the caller prepared.
        foreach (['file_get_contents(\'http', 'fsockopen', 'stream_socket_client'] as $needle) {
            if (str_contains($code, $needle)) {
                $offenders[] = basename($path).' opens '.$needle;
            }
        }
    }

    expect($offenders)->toBe([]);
});

it('keeps every source file loadable and every class named for its file', function () use ($sources) {
    // PSR-4 breaks silently: a mismatched name autoloads as "class not found"
    // only on the path that uses it, which may be the one nobody runs locally.
    $offenders = [];

    foreach ($sources() as $path => $source) {
        $expected = basename($path, '.php');

        if (preg_match('/^(?:final |abstract |readonly |final readonly )*(?:class|interface|enum|trait) (\w+)/m', $source, $matches) !== 1) {
            $offenders[] = basename($path).' declares no type';

            continue;
        }

        if ($matches[1] !== $expected) {
            $offenders[] = basename($path)." declares {$matches[1]}";
        }

        if (! str_contains($source, 'declare(strict_types=1);')) {
            $offenders[] = basename($path).' is not strict';
        }
    }

    expect($offenders)->toBe([]);
});
