//! `geography` and `geometry` (DB-29): SQL Server sends them as CLR values in its own format
//! (MS-SSCLRT), which no viewer reads. A value that is one, read whole, becomes EWKB with its
//! SRID, as PostGIS sends it, without changing the person's queries; anything else (a
//! `hierarchyid`, a curve, a value cut short) stays its bytes.
//!
//! The metadata of a result names no type of a UDT column, so `geography` is told from
//! `geometry` by its SRID: one of a geographic system (4000 to 4999, as 4326) holds latitude
//! before longitude, and is turned to longitude before latitude.

/// Points, figures and shapes of a value, as the format lays them out.
struct Clr<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl Clr<'_> {
    fn take(&mut self, count: usize) -> Option<&[u8]> {
        let end = self.at.checked_add(count)?;
        let slice = self.bytes.get(self.at..end)?;
        self.at = end;
        Some(slice)
    }
    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }
    fn i32(&mut self) -> Option<i32> {
        self.take(4)
            .map(|b| i32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn f64(&mut self) -> Option<f64> {
        let b = self.take(8)?;
        Some(f64::from_le_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }
}

struct Shape {
    parent: i32,
    figure: i32,
    kind: u8,
}

/// The EWKB of a geometry, little endian, two dimensions.
struct Wkb(Vec<u8>);
impl Wkb {
    fn kind(&mut self, kind: u32, srid: Option<i32>) {
        self.0.push(1);
        match srid {
            Some(srid) => {
                self.0.extend((kind | 0x2000_0000).to_le_bytes());
                self.0.extend(srid.to_le_bytes());
            }
            None => self.0.extend(kind.to_le_bytes()),
        }
    }
    fn count(&mut self, count: usize) {
        self.0.extend((count as u32).to_le_bytes());
    }
    fn point(&mut self, (x, y): (f64, f64)) {
        self.0.extend(x.to_le_bytes());
        self.0.extend(y.to_le_bytes());
    }
}

const MAX_POINTS: usize = 10_000_000;

/// EWKB in hexadecimal capitals of a CLR spatial value, or none when it is not one.
pub(crate) fn ewkb_hex(bytes: &[u8]) -> Option<String> {
    let ewkb = ewkb(bytes)?;
    Some(ewkb.iter().map(|byte| format!("{byte:02X}")).collect())
}

fn ewkb(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut clr = Clr { bytes, at: 0 };
    let srid = clr.i32()?;
    let version = clr.u8()?;
    if version != 1 && version != 2 {
        return None;
    }
    let props = clr.u8()?;
    let (z, m) = (props & 0x01 != 0, props & 0x02 != 0);
    let geographic = (4000..5000).contains(&srid);
    let order = |a: f64, b: f64| if geographic { (b, a) } else { (a, b) };
    let mut wkb = Wkb(Vec::new());
    // A single point, or a single line segment.
    if props & 0x08 != 0 || props & 0x10 != 0 {
        let count = if props & 0x08 != 0 { 1 } else { 2 };
        let mut points = Vec::new();
        for _ in 0..count {
            let (a, b) = (clr.f64()?, clr.f64()?);
            points.push(order(a, b));
        }
        clr.take(count * 8 * (usize::from(z) + usize::from(m)))?;
        if clr.at != bytes.len() {
            return None;
        }
        if count == 1 {
            wkb.kind(1, Some(srid));
            wkb.point(points[0]);
        } else {
            wkb.kind(2, Some(srid));
            wkb.count(2);
            points.into_iter().for_each(|p| wkb.point(p));
        }
        return Some(wkb.0);
    }
    let count = usize::try_from(clr.i32()?)
        .ok()
        .filter(|c| *c <= MAX_POINTS)?;
    let mut points = Vec::with_capacity(count);
    for _ in 0..count {
        let (a, b) = (clr.f64()?, clr.f64()?);
        points.push(order(a, b));
    }
    clr.take(count * 8 * (usize::from(z) + usize::from(m)))?;
    let figures_count = usize::try_from(clr.i32()?).ok()?;
    let mut figures = Vec::new();
    for _ in 0..figures_count {
        let _attribute = clr.u8()?;
        figures.push(usize::try_from(clr.i32()?).ok()?);
    }
    let shapes_count = usize::try_from(clr.i32()?).ok().filter(|c| *c > 0)?;
    let mut shapes = Vec::new();
    for _ in 0..shapes_count {
        shapes.push(Shape {
            parent: clr.i32()?,
            figure: clr.i32()?,
            kind: clr.u8()?,
        });
    }
    if version == 2 && clr.at < bytes.len() {
        // Segments of curves: arcs are not drawn.
        let segments = clr.i32()?;
        if segments != 0 {
            return None;
        }
    }
    if clr.at != bytes.len() || shapes.iter().any(|shape| !(1..=7).contains(&shape.kind)) {
        return None;
    }
    let layout = Layout {
        points,
        figures,
        shapes,
    };
    layout.write(0, Some(srid), &mut wkb)?;
    Some(wkb.0)
}

struct Layout {
    points: Vec<(f64, f64)>,
    figures: Vec<usize>,
    shapes: Vec<Shape>,
}
impl Layout {
    /// The figures of a shape: from its own to the next shape's that has some.
    fn figures(&self, shape: usize) -> std::ops::Range<usize> {
        let Ok(start) = usize::try_from(self.shapes[shape].figure) else {
            return 0..0;
        };
        let end = self.shapes[shape + 1..]
            .iter()
            .find_map(|next| usize::try_from(next.figure).ok())
            .unwrap_or(self.figures.len());
        start..end.max(start)
    }
    /// The points of a figure: from its own to the next figure's.
    fn points(&self, figure: usize) -> Option<&[(f64, f64)]> {
        let start = *self.figures.get(figure)?;
        let end = self
            .figures
            .get(figure + 1)
            .copied()
            .unwrap_or(self.points.len());
        self.points.get(start..end.max(start))
    }
    fn write(&self, shape: usize, srid: Option<i32>, wkb: &mut Wkb) -> Option<()> {
        let kind = u32::from(self.shapes.get(shape)?.kind);
        wkb.kind(kind, srid);
        let figures = self.figures(shape);
        match kind {
            1 => match figures.clone().next() {
                Some(figure) => wkb.point(*self.points(figure)?.first()?),
                None => wkb.point((f64::NAN, f64::NAN)),
            },
            2 => {
                let points = figures
                    .clone()
                    .next()
                    .map_or(Some(&[][..]), |f| self.points(f))?;
                wkb.count(points.len());
                points.iter().for_each(|p| wkb.point(*p));
            }
            3 => {
                wkb.count(figures.len());
                for figure in figures {
                    let points = self.points(figure)?;
                    wkb.count(points.len());
                    points.iter().for_each(|p| wkb.point(*p));
                }
            }
            _ => {
                let children: Vec<usize> = (shape + 1..self.shapes.len())
                    .filter(|child| usize::try_from(self.shapes[*child].parent).ok() == Some(shape))
                    .collect();
                wkb.count(children.len());
                for child in children {
                    self.write(child, None, wkb)?;
                }
            }
        }
        Some(())
    }
}

#[cfg(test)]
mod tests;
