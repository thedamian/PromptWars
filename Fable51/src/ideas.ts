export const ideas: string[] = [
  "A website for Santa Claus",
  "A website for dogs to find the best parks in the area",
  "A website for a remote little Airbnb in Antarctica",
  "A dating app for lonely garden gnomes looking for the perfect lawn",
  "A website where ghosts list haunted houses for rent",
  "An app that lets cats leave one-star reviews of their humans",
  "A site for pirates to compare buried-treasure insurance plans",
  "A ride-sharing app for witches whose brooms are in the shop",
  "A website for a bakery that only sells bread shaped like famous landmarks",
  "An app that helps aliens decode confusing human small talk",
  "A weather site made exclusively for clouds",
  "A LinkedIn-style network for retired superheroes",
  "A website for a gym where dinosaurs train for the next meteor",
  "An online store that sells single socks to people who lost the other one",
  "A travel agency site for time travelers who keep missing their connections",
  "A food-delivery app run entirely by very slow sloths",
  "A website for a library where the books read you",
  "A booking site for a hotel located inside an active volcano",
  "An app that matches squirrels with the best acorn-hiding spots",
  "A streaming service that only shows videos of paint drying, with premium tiers",
  "A website for a dragon-run dental clinic",
  "A marketplace where robots sell their gently used emotions",
  "A fan site for the world's most boring rock",
  "A cooking school for vampires who can't stand garlic",
  "A ticketing site for the Annual Penguin Formal Wear Convention",
  "A real-estate site for mermaids looking for underwater condos",
  "An app that translates what your houseplants are complaining about",
  "A website for a coffee shop on the Moon with very low gravity lattes"
];

export function pickIdea(exclude?: string): string {
  const pool = ideas.filter((i) => i !== exclude);
  return pool[Math.floor(Math.random() * pool.length)];
}
