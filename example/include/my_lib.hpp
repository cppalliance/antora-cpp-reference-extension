/** Return the distance between two points

    This function returns the distance between two points
    according to the Euclidean distance formula.

    @param x0 The x-coordinate of the first point
    @param y0 The y-coordinate of the first point
    @param x1 The x-coordinate of the second point
    @param y1 The y-coordinate of the second point
    @return The distance between the two points
*/
double
distance(double x0, double y0, double x1, double y1);

namespace math {
namespace geometry {

/** Axis-aligned bounding box inside a nested namespace.

    This struct intentionally lives under math::geometry to help the
    synthetic breadcrumb prototype exercise multi-level namespaces.

    @tparam T coordinate type
*/
template <class T>
struct bounding_box
{
    T x0;
    T y0;
    T x1;
    T y1;
};

/// Return the horizontal span of the box
template <class T>
T
width(const bounding_box<T>& box)
{
    return box.x1 - box.x0;
}

} // namespace geometry
} // namespace math
