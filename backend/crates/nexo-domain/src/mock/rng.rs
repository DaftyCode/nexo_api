//! The random numbers of test data: SplitMix64, seeded for each cell by the seed of the run,
//! the column and the row, so a cell is the same whichever batch makes it.

pub(crate) struct Rng(u64);

impl Rng {
    pub(crate) fn new(seed: u64, column: usize, row: u64) -> Self {
        let mut rng = Self(seed ^ 0x9E37_79B9_7F4A_7C15);
        rng.0 ^= rng.next().wrapping_add(column as u64);
        rng.0 ^= rng.next().wrapping_add(row);
        rng
    }
    pub(crate) fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// A number from 0 to `limit - 1`; 0 when `limit` is 0.
    pub(crate) fn below(&mut self, limit: u64) -> u64 {
        if limit == 0 { 0 } else { self.next() % limit }
    }
    /// A number from 0 to 1, 1 excluded.
    pub(crate) fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1_u64 << 53) as f64
    }
    pub(crate) fn pick<'a>(&mut self, list: &[&'a str]) -> &'a str {
        list[self.below(list.len() as u64) as usize]
    }
    pub(crate) fn digit(&mut self) -> char {
        char::from(b'0' + self.below(10) as u8)
    }
    pub(crate) fn letter(&mut self, upper: bool) -> char {
        char::from(if upper { b'A' } else { b'a' } + self.below(26) as u8)
    }
}

/// The `row`-th of `size` values, each one once while `row` is below `size`: an affine
/// permutation whose step is coprime with the size, offset by the seed.
pub(crate) fn permuted(row: u64, size: u64, seed: u64) -> u64 {
    if size <= 1 {
        return 0;
    }
    let gcd = |mut a: u64, mut b: u64| {
        while b != 0 {
            (a, b) = (b, a % b);
        }
        a
    };
    let mut step = (seed % size) | 1;
    while gcd(step, size) != 1 {
        step += 2;
    }
    ((u128::from(row) * u128::from(step) + u128::from(seed)) % u128::from(size)) as u64
}
