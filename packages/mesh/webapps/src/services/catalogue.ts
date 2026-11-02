// the self-hosted catalogue: each a recipe installing it on the host itself
// (native.ts), in five lists by their place; append only, a recipe's place
// being its port
import { servicesOf } from "./native.ts";
import { recipes as a } from "./recipes/a.ts";
import { recipes as b } from "./recipes/b.ts";
import { recipes as c } from "./recipes/c.ts";
import { recipes as d } from "./recipes/d.ts";
import { recipes as e } from "./recipes/e.ts";

export const Catalogue = servicesOf([...a, ...b, ...c, ...d, ...e]);
