//! The catalogs of test data, in English and Spanish: names (the lists of the masking rules),
//! emails, phones, cities, countries, companies, streets, IBANs with a valid check, UUIDs and
//! URLs; and the days of the calendar dates are drawn from.
use super::rng::Rng;
use crate::masking::{FIRST_NAMES, LAST_NAMES};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Catalog {
    FirstName,
    LastName,
    FullName,
    Email,
    Phone,
    City,
    Country,
    Company,
    Street,
    Iban,
    Uuid,
    Url,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    #[default]
    En,
    Es,
}

const CITIES_EN: [&str; 12] = [
    "London",
    "New York",
    "Toronto",
    "Sydney",
    "Dublin",
    "Chicago",
    "Boston",
    "Seattle",
    "Manchester",
    "Austin",
    "Denver",
    "Auckland",
];
const CITIES_ES: [&str; 12] = [
    "Madrid",
    "Barcelona",
    "Sevilla",
    "Valencia",
    "Bilbao",
    "Zaragoza",
    "Málaga",
    "Granada",
    "Ciudad de México",
    "Buenos Aires",
    "Lima",
    "Bogotá",
];
const COUNTRIES_EN: [&str; 10] = [
    "United Kingdom",
    "United States",
    "Canada",
    "Australia",
    "Ireland",
    "New Zealand",
    "Germany",
    "France",
    "Japan",
    "India",
];
const COUNTRIES_ES: [&str; 10] = [
    "España",
    "México",
    "Argentina",
    "Colombia",
    "Perú",
    "Chile",
    "Uruguay",
    "Francia",
    "Alemania",
    "Portugal",
];
const COMPANIES_EN: [&str; 10] = [
    "Acme Ltd",
    "Northwind",
    "Blue Harbor",
    "Silverline",
    "Maple & Co",
    "Brightway",
    "Ironbridge",
    "Greenfield",
    "Summit Labs",
    "Oakwood",
];
const COMPANIES_ES: [&str; 10] = [
    "Hermanos Ruiz SL",
    "Talleres del Norte",
    "Grupo Alba",
    "Soluciones Vega",
    "Distribuciones Sol",
    "Construcciones Mar",
    "Ibérica Digital",
    "Cooperativa del Sur",
    "Logística Centro",
    "Viñedos Altos",
];
const STREETS_EN: [&str; 10] = [
    "High Street",
    "Station Road",
    "Main Street",
    "Park Avenue",
    "Church Lane",
    "Mill Road",
    "Oak Street",
    "King Street",
    "Elm Avenue",
    "Bridge Road",
];
const STREETS_ES: [&str; 10] = [
    "Calle Mayor",
    "Avenida de la Constitución",
    "Calle Real",
    "Paseo del Prado",
    "Calle Nueva",
    "Avenida del Puerto",
    "Calle de la Paz",
    "Plaza España",
    "Calle Alcalá",
    "Ronda Sur",
];

fn ascii(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            'á' => 'a',
            'é' => 'e',
            'í' => 'i',
            'ó' => 'o',
            'ú' | 'ü' => 'u',
            'ñ' => 'n',
            other => other,
        })
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_ascii_lowercase()
}

/// An IBAN of the country with a BBAN of `digits` digits and its check digits (ISO 13616).
fn iban(rng: &mut Rng, country: &str, digits: usize) -> String {
    let bban: String = (0..digits).map(|_| rng.digit()).collect();
    let numeric: String = format!("{bban}{country}00")
        .chars()
        .map(|c| match c {
            'A'..='Z' => (c as u32 - 'A' as u32 + 10).to_string(),
            other => other.to_string(),
        })
        .collect();
    let rest = numeric.chars().fold(0_u32, |rest, c| {
        (rest * 10 + c.to_digit(10).unwrap_or(0)) % 97
    });
    format!("{country}{:02}{bban}", 98 - rest)
}

pub(super) fn value(catalog: Catalog, language: Language, rng: &mut Rng) -> String {
    let es = language == Language::Es;
    let pick = |rng: &mut Rng, en: &[&str], es_list: &[&str]| {
        rng.pick(if es { es_list } else { en }).to_string()
    };
    match catalog {
        Catalog::FirstName => rng.pick(&FIRST_NAMES).to_string(),
        Catalog::LastName => rng.pick(&LAST_NAMES).to_string(),
        Catalog::FullName => format!("{} {}", rng.pick(&FIRST_NAMES), rng.pick(&LAST_NAMES)),
        Catalog::Email => format!(
            "{}.{}@example.com",
            ascii(rng.pick(&FIRST_NAMES)),
            ascii(rng.pick(&LAST_NAMES))
        ),
        Catalog::Phone if es => {
            let rest: String = (0..8).map(|_| rng.digit()).collect();
            format!("+34 6{} {} {}", &rest[..2], &rest[2..5], &rest[5..])
        }
        Catalog::Phone => {
            let rest: String = (0..7).map(|_| rng.digit()).collect();
            format!("+1 555 {}-{}", &rest[..3], &rest[3..])
        }
        Catalog::City => pick(rng, &CITIES_EN, &CITIES_ES),
        Catalog::Country => pick(rng, &COUNTRIES_EN, &COUNTRIES_ES),
        Catalog::Company => pick(rng, &COMPANIES_EN, &COMPANIES_ES),
        Catalog::Street => format!(
            "{} {}",
            pick(rng, &STREETS_EN, &STREETS_ES),
            rng.below(200) + 1
        ),
        Catalog::Iban if es => iban(rng, "ES", 20),
        Catalog::Iban => iban(rng, "DE", 18),
        Catalog::Uuid => {
            let (a, b) = (rng.next(), rng.next());
            let hex = format!("{a:016x}{b:016x}");
            format!(
                "{}-{}-4{}-{:x}{}-{}",
                &hex[..8],
                &hex[8..12],
                &hex[13..16],
                8 + (b % 4),
                &hex[17..20],
                &hex[20..32]
            )
        }
        Catalog::Url => format!(
            "https://{}.example.com/{}",
            ascii(rng.pick(&LAST_NAMES)),
            rng.below(10_000)
        ),
    }
}

/// The days since 1970-01-01 of a date `YYYY-MM-DD`.
pub(super) fn days(date: &str) -> Option<i64> {
    let mut parts = date.trim().get(..10)?.split('-');
    let (y, m, d): (i64, i64, i64) = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// The date `YYYY-MM-DD` of some days since 1970-01-01.
pub(super) fn date(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}
