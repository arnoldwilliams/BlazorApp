namespace PdfReaderApp.Services;

/// <summary>
/// Splits page text into utterance sized chunks. Browsers silently truncate or refuse
/// very long utterances, and the speech boundary events are only useful for small units.
/// </summary>
public static class TextChunker
{
    private const int DefaultMaxLength = 220;

    private static readonly char[] SentenceTerminators = ['.', '!', '?', ';', ':', '\n', '\r', '\u2022', '\u2023', '\u25CF'];

    public static IEnumerable<string> Split(string text, int maxLength = DefaultMaxLength)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            yield break;
        }

        var start = 0;
        var length = text.Length;

        while (start < length)
        {
            var end = Math.Min(start + maxLength, length);

            if (end < length)
            {
                var boundary = FindBreak(text, start, end);
                if (boundary > start)
                {
                    end = boundary;
                }
            }

            var chunk = text[start..end];
            if (!string.IsNullOrWhiteSpace(chunk))
            {
                yield return chunk;
            }

            start = end;
        }
    }

    /// <summary>Finds the best split point at or before <paramref name="limit"/>.</summary>
    private static int FindBreak(string text, int start, int limit)
    {
        var best = -1;
        foreach (var terminator in SentenceTerminators)
        {
            var index = text.LastIndexOf(terminator, limit - 1, limit - start);
            if (index > best)
            {
                best = index;
            }
        }

        if (best > start)
        {
            return best + 1;
        }

        // Fall back to the last space so words stay intact.
        var space = text.LastIndexOf(' ', limit - 1, limit - start);
        return space > start ? space + 1 : limit;
    }
}