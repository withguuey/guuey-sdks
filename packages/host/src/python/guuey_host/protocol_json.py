"""JSON exactly as JavaScript reads and writes it: the codec every worker-protocol line goes through.

The worker line protocol is defined by ``@guuey/worker``, which parses with ``JSON.parse`` and writes with
``JSON.stringify``. Python's ``json`` module differs from both in ways that change bytes on the wire, so this module
pins the JavaScript behaviour:

- Numbers. JavaScript has one number type (an IEEE double). ``2.0`` and ``2`` are the same value and both print as
  ``2``; ``1e21`` prints as ``1e+21``; an integer past 2**53 loses precision on the way in. Parsed numbers here are an
  ``int`` when the double is integral and within 2**53, otherwise a ``float``; every number prints with ECMAScript's
  Number-to-String rules. ``NaN``/``Infinity`` literals are refused on the way in (``JSON.parse`` refuses them) and a
  non-finite float prints as ``null`` (as ``JSON.stringify`` writes it).
- Key order. A JavaScript object lists its array-index keys (``"0"`` .. ``"4294967294"``) first, ascending, then every
  other key in insertion order. Both the parser and the writer here apply that order, so an opaque blob passed
  through (``priorState``, a ``native`` event) comes out byte-identical.
- Strings. ``JSON.stringify`` writes every character literally except ``"``, ``\\``, the C0 controls (short escapes
  where JSON has one, else ``\\u00xx``) and lone surrogates (``\\udxxx``). Python's encoder escapes differently.
- Whitespace. ``String.prototype.trim`` strips a different set of characters than ``str.strip``; see :func:`js_trim`.

Known divergence, by design not papered over: a line nested deeper than Python's recursion limit raises
``RecursionError`` here, where V8's iterative parser would accept it.
"""

import json
import math
import re
from dataclasses import dataclass
from typing import Final

type JsonValue = str | int | float | bool | None | list[JsonValue] | dict[str, JsonValue]
"""A JSON value: the precise parse target for a protocol line (``JsonValue`` in protocol.ts)."""

type JsonObject = dict[str, JsonValue]
"""A JSON object whose members the protocol does not shape (an opaque blob, forwarded verbatim)."""

_MAX_SAFE_INTEGER: Final = 2**53
_MAX_ARRAY_INDEX: Final = 2**32 - 2
_ARRAY_INDEX: Final = re.compile(r"0|[1-9][0-9]{0,9}")

# String.prototype.trim: WhiteSpace (TAB, VT, FF, ZWNBSP and every Zs character) plus LineTerminator (LF, CR, LS,
# PS). Unlike str.strip it keeps U+001C..U+001F and U+0085, and strips U+FEFF.
_JS_WHITESPACE: Final = (
    "\t\n\v\f\r              "
    "    　﻿"
)


@dataclass(frozen=True, slots=True)
class JsonSyntaxFailure:
    """The text is not one complete JSON value (where ``JSON.parse`` throws a SyntaxError)."""


def _js_number(value: float) -> int | float:
    """The parsed double as this module represents it: an ``int`` when integral and safe, else the ``float``."""
    if math.isfinite(value) and value.is_integer() and abs(value) <= _MAX_SAFE_INTEGER:
        return int(value)
    return value


def _parse_number(text: str) -> int | float:
    # Every JSON number is a double in JavaScript, integer literals included ("9007199254740993" reads as
    # 9007199254740992, "1" * 400 as Infinity), so both hooks go through float.
    return _js_number(float(text))


def _refuse_constant(name: str) -> JsonValue:
    raise ValueError(f"JSON has no {name} literal")


def _is_array_index(key: str) -> bool:
    return _ARRAY_INDEX.fullmatch(key) is not None and int(key) <= _MAX_ARRAY_INDEX


def _js_key_order(obj: JsonObject) -> JsonObject:
    """``obj`` with its keys in JavaScript's own-property order: array indexes ascending, then the rest as inserted."""
    index_keys = sorted((key for key in obj if _is_array_index(key)), key=int)
    if not index_keys:
        return obj
    ordered: JsonObject = {key: obj[key] for key in index_keys}
    for key, value in obj.items():
        if not _is_array_index(key):
            ordered[key] = value
    return ordered


def _js_object(pairs: list[tuple[str, JsonValue]]) -> JsonObject:
    # A repeated key keeps its FIRST position and its LAST value, as JSON.parse's CreateDataProperty does.
    obj: JsonObject = {}
    for key, value in pairs:
        obj[key] = value
    return _js_key_order(obj)


_DECODER: Final = json.JSONDecoder(
    object_pairs_hook=_js_object,
    parse_int=_parse_number,
    parse_float=_parse_number,
    parse_constant=_refuse_constant,
)


def js_json_try_parse(text: str) -> JsonValue | JsonSyntaxFailure:
    """``JSON.parse(text)``, or :class:`JsonSyntaxFailure` where ``JSON.parse`` throws."""
    try:
        parsed: JsonValue = _DECODER.decode(text)
    except ValueError:
        return JsonSyntaxFailure()
    return parsed


def js_number_text(value: float) -> str:
    """ECMAScript ``Number::toString`` (radix 10) as ``JSON.stringify`` uses it; ``null`` for a non-finite value."""
    if not math.isfinite(value):
        return "null"
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    # repr gives the shortest digit string that round-trips, the same digits ECMAScript requires.
    mantissa, _, exponent = repr(abs(value)).partition("e")
    whole, _, fraction = mantissa.partition(".")
    digits = whole + fraction
    point = len(whole) + (int(exponent) if exponent else 0)
    significant = digits.lstrip("0")
    point -= len(digits) - len(significant)
    significant = significant.rstrip("0")
    k = len(significant)
    n = point
    if k <= n <= 21:
        return sign + significant + "0" * (n - k)
    if 0 < n <= 21:
        return sign + significant[:n] + "." + significant[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + significant
    e = n - 1
    exponent_text = ("+" if e >= 0 else "-") + str(abs(e))
    if k == 1:
        return sign + significant + "e" + exponent_text
    return sign + significant[0] + "." + significant[1:] + "e" + exponent_text


def _int_text(value: int) -> str:
    if abs(value) <= _MAX_SAFE_INTEGER:
        return str(value)
    try:
        as_double = float(value)
    except OverflowError:
        # Past the largest double: JavaScript holds Infinity, which JSON.stringify writes as null.
        return "null"
    return js_number_text(as_double)


_QUOTE_PATTERN: Final = re.compile('[\ud800-\udbff][\udc00-\udfff]|[\x00-\x1f"\\\\\ud800-\udfff]')
_SHORT_ESCAPES: Final = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}


def _quote_one(match: re.Match[str]) -> str:
    text = match.group()
    if len(text) == 2:
        # A surrogate pair held as two code units: one character, written literally.
        high, low = ord(text[0]), ord(text[1])
        return chr(0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00))
    short = _SHORT_ESCAPES.get(text)
    if short is not None:
        return short
    return f"\\u{ord(text):04x}"


def js_quote(text: str) -> str:
    """``JSON.stringify(text)`` for a string: QuoteJSONString, well-formed (lone surrogates escaped)."""
    return '"' + _QUOTE_PATTERN.sub(_quote_one, text) + '"'


def _write(value: JsonValue, out: list[str]) -> None:
    if value is None:
        out.append("null")
    elif value is True:
        out.append("true")
    elif value is False:
        out.append("false")
    elif isinstance(value, str):
        out.append(js_quote(value))
    elif isinstance(value, int):
        out.append(_int_text(value))
    elif isinstance(value, float):
        out.append(js_number_text(value))
    elif isinstance(value, list):
        out.append("[")
        for index, item in enumerate(value):
            if index > 0:
                out.append(",")
            _write(item, out)
        out.append("]")
    elif isinstance(value, dict):
        out.append("{")
        for index, (key, item) in enumerate(_js_key_order(value).items()):
            if not isinstance(key, str):
                raise TypeError(f"a JSON object key must be a string, not {type(key).__name__}")
            if index > 0:
                out.append(",")
            out.append(js_quote(key))
            out.append(":")
            _write(item, out)
        out.append("}")
    else:
        raise TypeError(f"not a JSON value: {type(value).__name__}")


def js_json_stringify(value: JsonValue) -> str:
    """``JSON.stringify(value)``: compact, JavaScript key order, JavaScript number and string forms."""
    out: list[str] = []
    _write(value, out)
    return "".join(out)


def utf16_prefix(text: str, units: int) -> str:
    """``text.slice(0, units)`` in JavaScript, whose strings count UTF-16 code units.

    A cut through a surrogate pair keeps the pair's high surrogate alone, exactly as ``slice`` does.
    """
    if len(text) * 2 <= units:
        return text
    count = 0
    for index, char in enumerate(text):
        width = 2 if ord(char) > 0xFFFF else 1
        if count + width > units:
            if width == 2 and count + 1 == units:
                return text[:index] + chr(0xD800 + ((ord(char) - 0x10000) >> 10))
            return text[:index]
        count += width
    return text


def js_trim(text: str) -> str:
    """``String.prototype.trim``."""
    return text.strip(_JS_WHITESPACE)
